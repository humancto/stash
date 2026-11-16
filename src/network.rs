//! What torrent peers can see: which interface stash's traffic leaves on,
//! whether that looks like a VPN tunnel, and the public IP and country.
//!
//! The probe reports where *general* traffic goes. Torrent traffic may be
//! narrower: the kill switch (`privacy.rs`) binds it to the VPN tunnel or
//! blocks it, and `/api/network` reports that binding separately as
//! `kill_switch`.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const TTL: Duration = Duration::from_secs(30);
const TTL_AFTER_FAILURE: Duration = Duration::from_secs(5);
const REFRESH_FLOOR: Duration = Duration::from_secs(5);
const MAX_TRACE_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Tunnel,
    Exposed,
    Offline,
}

#[derive(Clone, Debug, Serialize)]
pub struct Family {
    pub route: bool,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Detail>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Detail {
    pub interface: Option<String>,
    pub tunnel: bool,
    pub route_consistent: bool,
    pub local_ip: String,
    pub public_ip: Option<String>,
    pub country: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub verdict: Verdict,
    pub checked_at: u64,
    pub lookup_enabled: bool,
    pub ipv4: Family,
    pub ipv6: Family,
}

impl Report {
    fn lookup_failed(&self) -> bool {
        [&self.ipv4, &self.ipv6]
            .iter()
            .any(|f| f.detail.as_ref().is_some_and(|d| d.error.is_some()))
    }
}

/// The verdict comes from the interfaces only; the public-IP lookup is
/// informational and never changes it.
pub fn verdict(families: &[&Family]) -> Verdict {
    let routed: Vec<&Detail> = families.iter().filter_map(|f| f.detail.as_ref()).collect();
    if routed.is_empty() {
        Verdict::Offline
    } else if routed.iter().all(|d| d.tunnel) {
        Verdict::Tunnel
    } else {
        Verdict::Exposed
    }
}

/// Layer-3 tunnels (utun, tun, wg, nordlynx, proton0) have no hardware
/// address; Ethernet and Wi-Fi do. Names are a tiebreaker. Links that are
/// usually the ISP itself are never a tunnel, even without a hardware
/// address: `ppp*` (PPPoE) and cellular modems (`wwan*`, `ww*`, `rmnet*`).
pub fn is_tunnel(name: &str, has_mac: bool, loopback: bool) -> bool {
    const NAMES: [&str; 9] = [
        "utun",
        "tun",
        "wg",
        "tailscale",
        "nordlynx",
        "proton",
        "ipsec",
        "gpd",
        "zt",
    ];
    const ISP_LINKS: [&str; 3] = ["ppp", "ww", "rmnet"];
    if loopback || ISP_LINKS.iter().any(|p| name.starts_with(p)) {
        return false;
    }
    NAMES.iter().any(|p| name.starts_with(p)) || !has_mac
}

/// Parses Cloudflare's `/cdn-cgi/trace` body: `key=value` lines.
pub fn parse_trace(body: &str) -> Option<(IpAddr, Option<String>)> {
    let mut ip = None;
    let mut country = None;
    for line in body.lines() {
        let Some((k, v)) = line.trim_end_matches('\r').split_once('=') else {
            continue;
        };
        match k {
            "ip" => ip = v.trim().parse::<IpAddr>().ok(),
            "loc" => {
                let v = v.trim();
                if v.len() == 2 && v.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    country = Some(v.to_ascii_uppercase());
                }
            }
            _ => {}
        }
    }
    ip.map(|ip| (ip, country))
}

/// `STASH_IP_LOOKUP`: on unless explicitly off. Unknown values warn.
pub fn lookup_enabled_from(value: Option<&str>) -> bool {
    let Some(v) = value else { return true };
    match v.trim().to_ascii_lowercase().as_str() {
        "off" | "0" | "false" | "no" => false,
        "on" | "1" | "true" | "yes" | "" => true,
        other => {
            tracing::warn!(
                value = other,
                "STASH_IP_LOOKUP not understood; lookup stays on"
            );
            true
        }
    }
}

/// Source IP the OS would use towards `target`. Connecting a UDP socket
/// sends no packets; it only asks the kernel to choose a route.
fn source_for(target: SocketAddr) -> Option<IpAddr> {
    let bind: SocketAddr = match target {
        SocketAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        SocketAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let sock = UdpSocket::bind(bind).ok()?;
    sock.connect(target).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    let usable = !ip.is_unspecified()
        && match ip {
            IpAddr::V4(a) => !a.is_link_local(),
            IpAddr::V6(a) => (a.segments()[0] & 0xffc0) != 0xfe80,
        };
    usable.then_some(ip)
}

struct IfaceInfo {
    name: String,
    tunnel: bool,
}

/// The interface that owns `ip`, if exactly one does.
fn iface_for(ifaces: &[NetworkInterface], ip: IpAddr) -> Option<IfaceInfo> {
    let mut owners: Vec<&str> = ifaces
        .iter()
        .filter(|i| {
            i.addr.iter().any(|a| match (a, ip) {
                (Addr::V4(v), IpAddr::V4(x)) => v.ip == x,
                (Addr::V6(v), IpAddr::V6(x)) => v.ip == x,
                _ => false,
            })
        })
        .map(|i| i.name.as_str())
        .collect();
    owners.sort_unstable();
    owners.dedup();
    let [only] = owners.as_slice() else {
        return None;
    };
    let only = ifaces.iter().find(|i| i.name == *only)?;
    // An interface can appear once per address; any entry with a real MAC counts.
    let has_mac = ifaces.iter().any(|i| {
        i.name == only.name
            && i.mac_addr
                .as_deref()
                .is_some_and(|m| !m.is_empty() && m.chars().any(|c| c != '0' && c != ':'))
    });
    let loopback = ip.is_loopback() || only.internal;
    Some(IfaceInfo {
        tunnel: is_tunnel(&only.name, has_mac, loopback),
        name: only.name.clone(),
    })
}

struct Route {
    source: IpAddr,
    iface: Option<IfaceInfo>,
    consistent: bool,
}

fn route_family(ifaces: &[NetworkInterface], targets: &[SocketAddr]) -> Option<Route> {
    let sources: Vec<Option<IpAddr>> = targets.iter().map(|t| source_for(*t)).collect();
    let source = sources.iter().flatten().next().copied()?;
    let consistent = sources.iter().all(|s| *s == Some(source));
    Some(Route {
        source,
        iface: iface_for(ifaces, source),
        consistent,
    })
}

/// Interface carrying general IPv4 traffic now, and whether two neutral
/// targets agree on it. Used by the kill switch.
pub fn v4_route_iface() -> Option<(Option<String>, bool)> {
    let ifaces = NetworkInterface::show().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "could not list network interfaces");
        Vec::new()
    });
    let targets = ProbeConfig::public(false).v4_targets;
    route_family(&ifaces, &targets).map(|r| (r.iface.map(|i| i.name), r.consistent))
}

pub struct ProbeConfig {
    pub v4_targets: Vec<SocketAddr>,
    pub v6_targets: Vec<SocketAddr>,
    pub v4_trace: String,
    pub v6_trace: String,
    pub lookup_enabled: bool,
    pub timeout: Duration,
}

impl ProbeConfig {
    /// Neutral public targets (not DNS resolvers: VPNs often add host routes
    /// for those). Cloudflare's trace endpoints have IP SANs; the literal
    /// forces the address family.
    pub fn public(lookup_enabled: bool) -> Self {
        Self {
            v4_targets: vec![
                SocketAddr::from((Ipv4Addr::new(1, 2, 3, 4), 443)),
                SocketAddr::from((Ipv4Addr::new(9, 9, 9, 9), 443)),
            ],
            v6_targets: vec![
                SocketAddr::from((
                    Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888),
                    443,
                )),
                SocketAddr::from((Ipv6Addr::new(0x2a00, 0x1450, 0x4001, 0, 0, 0, 0, 1), 443)),
            ],
            v4_trace: "https://1.1.1.1/cdn-cgi/trace".into(),
            v6_trace: "https://[2606:4700:4700::1111]/cdn-cgi/trace".into(),
            lookup_enabled,
            timeout: Duration::from_secs(4),
        }
    }
}

type Clock = Box<dyn Fn() -> (Instant, SystemTime) + Send + Sync>;

struct Cached {
    report: Report,
    at: Instant,
    wall: SystemTime,
    ttl: Duration,
}

pub struct NetworkProbe {
    cfg: ProbeConfig,
    client: reqwest::Client,
    clock: Clock,
    cache: Mutex<Option<Cached>>,
}

impl NetworkProbe {
    pub fn new(cfg: ProbeConfig) -> anyhow::Result<Self> {
        Self::with_clock(cfg, Box::new(|| (Instant::now(), SystemTime::now())))
    }

    fn with_clock(cfg: ProbeConfig, clock: Clock) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            // A proxy would report its own IP, not the one peers see.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()?;
        Ok(Self {
            cfg,
            client,
            clock,
            cache: Mutex::new(None),
        })
    }

    /// Cached report. `force` bypasses the TTL but not the refresh floor.
    /// The lock is held across the probe so concurrent callers share one
    /// lookup. If the caller goes away mid-probe nothing is cached and the
    /// next caller starts over.
    pub async fn report(&self, force: bool) -> Report {
        let mut cache = self.cache.lock().await;
        let (now, wall) = (self.clock)();
        if let Some(c) = cache.as_ref() {
            // macOS `Instant` stops while asleep, so check the wall clock too;
            // a wall clock that went backwards expires the entry.
            if let Ok(wall_age) = wall.duration_since(c.wall) {
                let age = wall_age.max(now.saturating_duration_since(c.at));
                let limit = if force {
                    REFRESH_FLOOR.min(c.ttl)
                } else {
                    c.ttl
                };
                if age < limit {
                    return c.report.clone();
                }
            }
        }
        let report = self.probe(wall).await;
        let ttl = if report.lookup_failed() {
            TTL_AFTER_FAILURE
        } else {
            TTL
        };
        *cache = Some(Cached {
            report: report.clone(),
            at: now,
            wall,
            ttl,
        });
        report
    }

    async fn probe(&self, wall: SystemTime) -> Report {
        let v4 = self.cfg.v4_targets.clone();
        let v6 = self.cfg.v6_targets.clone();
        let (r4, r6) = tokio::task::spawn_blocking(move || {
            let ifaces = NetworkInterface::show().unwrap_or_else(|e| {
                tracing::warn!(error = %e, "could not list network interfaces");
                Vec::new()
            });
            (route_family(&ifaces, &v4), route_family(&ifaces, &v6))
        })
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "network route probe failed");
            (None, None)
        });

        let (ipv4, ipv6) = tokio::join!(
            self.family(r4, &self.cfg.v4_trace),
            self.family(r6, &self.cfg.v6_trace),
        );
        Report {
            verdict: verdict(&[&ipv4, &ipv6]),
            checked_at: wall.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            lookup_enabled: self.cfg.lookup_enabled,
            ipv4,
            ipv6,
        }
    }

    async fn family(&self, route: Option<Route>, trace: &str) -> Family {
        let Some(route) = route else {
            return Family {
                route: false,
                detail: None,
            };
        };
        let (public_ip, country, error) = if !self.cfg.lookup_enabled {
            (None, None, None)
        } else if !same_route(trace, route.source).await {
            // The lookup server would answer for a different route (VPNs
            // often route DNS resolvers like 1.1.1.1 specially).
            (
                None,
                None,
                Some("Lookup took a different route".to_string()),
            )
        } else {
            match self.lookup(trace).await {
                Ok((ip, c)) => (Some(ip.to_string()), c, None),
                Err(e) => (None, None, Some(e)),
            }
        };
        Family {
            route: true,
            detail: Some(Detail {
                tunnel: route.iface.as_ref().is_some_and(|i| i.tunnel),
                interface: route.iface.map(|i| i.name),
                route_consistent: route.consistent,
                local_ip: route.source.to_string(),
                public_ip,
                country,
                error,
            }),
        }
    }

    async fn lookup(&self, url: &str) -> Result<(IpAddr, Option<String>), String> {
        let fetch = async {
            let mut resp = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| describe(&e))?;
            if resp.status() != reqwest::StatusCode::OK {
                return Err(format!("Lookup answered {}", resp.status().as_u16()));
            }
            let mut body = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| describe(&e))? {
                if body.len() + chunk.len() > MAX_TRACE_BYTES {
                    return Err("Lookup answer was too large".into());
                }
                body.extend_from_slice(&chunk);
            }
            parse_trace(&String::from_utf8_lossy(&body))
                .ok_or_else(|| "Lookup answer had no IP".to_string())
        };
        tokio::time::timeout(self.cfg.timeout, fetch)
            .await
            .unwrap_or_else(|_| Err("Lookup timed out".into()))
    }
}

/// True when the OS routes to the lookup server from `source`, the address
/// the route probe found. Unparseable URLs count as different.
async fn same_route(url: &str, source: IpAddr) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or_default();
    let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    else {
        return false;
    };
    let target = SocketAddr::new(ip, u.port_or_known_default().unwrap_or(443));
    tokio::task::spawn_blocking(move || source_for(target) == Some(source))
        .await
        .unwrap_or(false)
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Lookup timed out".into()
    } else if e.is_connect() {
        "Could not reach the lookup service".into()
    } else {
        "Lookup failed".into()
    }
}

#[derive(Deserialize)]
pub struct NetworkQuery {
    refresh: Option<String>,
}

pub async fn handler(
    State(probe): State<Arc<NetworkProbe>>,
    State(privacy): State<Arc<crate::privacy::Privacy>>,
    Query(q): Query<NetworkQuery>,
) -> Response {
    let force = matches!(q.refresh.as_deref(), Some("1" | "true"));
    let mut body = serde_json::to_value(probe.report(force).await).unwrap_or_default();
    body["kill_switch"] = serde_json::to_value(privacy.report()).unwrap_or_default();
    let mut res = Json(body).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn trace_parsing() {
        let body = "fl=1\nh=1.1.1.1\nip=185.1.2.3\nts=1\nloc=NL\nwarp=off\n";
        assert_eq!(
            parse_trace(body),
            Some(("185.1.2.3".parse().unwrap(), Some("NL".into())))
        );
        assert_eq!(
            parse_trace("ip=2001:db8::1\r\nloc=us\r\n"),
            Some(("2001:db8::1".parse().unwrap(), Some("US".into())))
        );
        assert_eq!(
            parse_trace("ip=10.0.0.1\n"),
            Some(("10.0.0.1".parse().unwrap(), None))
        );
        assert_eq!(
            parse_trace("ip=1.2.3.4\nloc=T1\n").unwrap().1.as_deref(),
            Some("T1")
        );
        assert_eq!(parse_trace("ip=not-an-ip\nloc=NL"), None);
        assert_eq!(parse_trace("<html>captive portal</html>"), None);
        assert_eq!(parse_trace("ip=1.2.3.4\nloc=<script>\n").unwrap().1, None);
    }

    #[test]
    fn tunnel_table() {
        let cases = [
            ("utun4", false, false, true),
            ("utun4", true, false, true),
            ("wg0", false, false, true),
            ("proton0", false, false, true),
            ("nordlynx", false, false, true),
            ("tailscale0", false, false, true),
            ("tun0", false, false, true),
            ("weird0", false, false, true), // no MAC: layer-3
            ("en0", true, false, false),
            ("eth0", true, false, false),
            ("wlan0", true, false, false),
            ("ppp0", false, false, false),
            ("pppoe-wan", false, false, false),
            ("wwan0", false, false, false),
            ("wwp0s20f0u6", false, false, false),
            ("rmnet_data0", false, false, false),
            ("lo0", false, true, false),
        ];
        for (name, mac, lo, want) in cases {
            assert_eq!(is_tunnel(name, mac, lo), want, "{name} mac={mac} lo={lo}");
        }
    }

    fn fam(route: bool, tunnel: bool) -> Family {
        Family {
            route,
            detail: route.then(|| Detail {
                interface: Some("x".into()),
                tunnel,
                route_consistent: true,
                local_ip: "10.0.0.1".into(),
                public_ip: None,
                country: None,
                error: None,
            }),
        }
    }

    #[test]
    fn verdict_table() {
        use Verdict::*;
        let cases = [
            ((false, false), (false, false), Offline),
            ((true, true), (false, false), Tunnel),
            ((true, true), (true, true), Tunnel),
            ((true, true), (true, false), Exposed), // IPv6 leak
            ((true, false), (false, false), Exposed),
            ((false, false), (true, false), Exposed),
        ];
        for ((r4, t4), (r6, t6), want) in cases {
            assert_eq!(verdict(&[&fam(r4, t4), &fam(r6, t6)]), want);
        }
    }

    #[test]
    fn lookup_env_values() {
        assert!(lookup_enabled_from(None));
        assert!(lookup_enabled_from(Some("on")));
        assert!(lookup_enabled_from(Some("TRUE")));
        assert!(!lookup_enabled_from(Some("off")));
        assert!(!lookup_enabled_from(Some("0")));
        assert!(!lookup_enabled_from(Some(" No ")));
        assert!(lookup_enabled_from(Some("offf")));
    }

    #[test]
    fn json_shape() {
        let r = Report {
            verdict: Verdict::Exposed,
            checked_at: 5,
            lookup_enabled: true,
            ipv4: fam(true, false),
            ipv6: fam(false, false),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["verdict"], "exposed");
        assert_eq!(v["ipv4"]["route"], true);
        assert_eq!(v["ipv4"]["interface"], "x");
        assert_eq!(v["ipv6"], serde_json::json!({ "route": false }));
    }

    #[test]
    fn loopback_route_probe() {
        let ifaces = NetworkInterface::show().unwrap();
        let r = route_family(&ifaces, &["127.0.0.1:9".parse().unwrap()]).unwrap();
        assert_eq!(r.source, IpAddr::V4(Ipv4Addr::LOCALHOST));
        let iface = r.iface.expect("loopback interface");
        let want = if cfg!(target_os = "macos") {
            "lo0"
        } else {
            "lo"
        };
        assert_eq!(iface.name, want);
        assert!(!iface.tunnel);
        assert!(r.consistent);
        assert!(route_family(&ifaces, &[]).is_none());
    }

    #[tokio::test]
    async fn lookup_route_check() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert!(same_route("http://127.0.0.1:1/trace", lo).await);
        assert!(!same_route("http://127.0.0.1:1/trace", "10.9.9.9".parse().unwrap()).await);
        assert!(!same_route("http://example.com/trace", lo).await);
        assert!(!same_route("not a url", lo).await);
    }

    // ---- fake Cloudflare trace server ----

    async fn fake_server() -> (SocketAddr, Arc<AtomicUsize>) {
        use axum::{Router, http::StatusCode, response::Redirect, routing::get};
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let app = Router::new()
            .route(
                "/trace",
                get(move || {
                    let h = h.clone();
                    async move {
                        h.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        "ip=203.0.113.7\nloc=NL\n"
                    }
                }),
            )
            .route("/big", get(|| async { "x".repeat(10_000) }))
            .route("/redirect", get(|| async { Redirect::to("/trace") }))
            .route("/teapot", get(|| async { StatusCode::IM_A_TEAPOT }))
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "ip=1.2.3.4\n"
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (addr, hits)
    }

    fn cfg(addr: SocketAddr, path: &str) -> ProbeConfig {
        ProbeConfig {
            v4_targets: vec!["127.0.0.1:9".parse().unwrap()],
            v6_targets: vec![],
            v4_trace: format!("http://{addr}{path}"),
            v6_trace: String::new(),
            lookup_enabled: true,
            timeout: Duration::from_millis(500),
        }
    }

    #[tokio::test]
    async fn lookup_against_fake_server() {
        let (addr, _) = fake_server().await;
        let ok = NetworkProbe::new(cfg(addr, "/trace"))
            .unwrap()
            .report(false)
            .await;
        let d = ok.ipv4.detail.as_ref().unwrap();
        assert_eq!(d.public_ip.as_deref(), Some("203.0.113.7"));
        assert_eq!(d.country.as_deref(), Some("NL"));
        assert_eq!(d.error, None);
        assert!(!ok.ipv6.route);
        assert_eq!(ok.verdict, Verdict::Exposed); // loopback is not a tunnel

        for (path, want) in [
            ("/big", "Lookup answer was too large"),
            ("/redirect", "Lookup answered 303"),
            ("/teapot", "Lookup answered 418"),
            ("/slow", "Lookup timed out"),
        ] {
            let r = NetworkProbe::new(cfg(addr, path))
                .unwrap()
                .report(false)
                .await;
            let d = r.ipv4.detail.unwrap();
            assert_eq!(d.error.as_deref(), Some(want), "{path}");
            assert_eq!(d.public_ip, None);
        }

        let mut off = cfg(addr, "/trace");
        off.lookup_enabled = false;
        let r = NetworkProbe::new(off).unwrap().report(false).await;
        assert!(!r.lookup_enabled);
        let d = r.ipv4.detail.unwrap();
        assert_eq!((d.public_ip, d.error), (None, None));
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_lookup() {
        let (addr, hits) = fake_server().await;
        let probe = Arc::new(NetworkProbe::new(cfg(addr, "/trace")).unwrap());
        let calls = (0..8).map(|_| {
            let p = probe.clone();
            tokio::spawn(async move { p.report(false).await })
        });
        for c in calls {
            c.await.unwrap();
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ttl_refresh_floor_and_clock_jumps() {
        let (addr, hits) = fake_server().await;
        let base_i = Instant::now();
        let base_w = SystemTime::now();
        // (instant offset, wall offset in seconds; wall may go negative)
        let t = Arc::new(StdMutex::new((0u64, 0i64)));
        let tc = t.clone();
        let clock: Clock = Box::new(move || {
            let (i, w) = *tc.lock().unwrap();
            let wall = if w >= 0 {
                base_w + Duration::from_secs(w.unsigned_abs())
            } else {
                base_w - Duration::from_secs(w.unsigned_abs())
            };
            (base_i + Duration::from_secs(i), wall)
        });
        let probe = NetworkProbe::with_clock(cfg(addr, "/trace"), clock).unwrap();
        let set = |i: u64, w: i64| *t.lock().unwrap() = (i, w);
        let n = || hits.load(Ordering::SeqCst);

        probe.report(false).await;
        assert_eq!(n(), 1);
        set(10, 10);
        probe.report(false).await;
        assert_eq!(n(), 1, "inside TTL: cached");
        set(3, 3);
        probe.report(true).await;
        assert_eq!(n(), 1, "refresh inside the 5 s floor: cached");

        set(10, 10);
        let r = probe.report(true).await;
        assert_eq!(n(), 2, "refresh past the floor: probes");
        let first_checked = r.checked_at;
        // Sleep: Instant barely moves, wall clock jumps 40 s.
        set(12, 50);
        probe.report(false).await;
        assert_eq!(n(), 3, "wall clock past TTL: probes");
        assert!(probe.cache.lock().await.as_ref().unwrap().report.checked_at > first_checked);
        // Wall clock moves backwards: expired.
        set(13, -100);
        probe.report(false).await;
        assert_eq!(n(), 4);
    }

    /// Real Cloudflare endpoints, both families. Run with `--ignored`.
    #[tokio::test]
    #[ignore = "needs the internet"]
    async fn real_cloudflare_trace() {
        let probe = NetworkProbe::new(ProbeConfig::public(true)).unwrap();
        for i in NetworkInterface::show().unwrap() {
            println!("{} mac={:?} internal={}", i.name, i.mac_addr, i.internal);
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&probe.report(false).await).unwrap()
        );
        for url in [&probe.cfg.v4_trace, &probe.cfg.v6_trace] {
            match probe.lookup(url).await {
                Ok((ip, loc)) => println!("{url}: {ip} {loc:?}"),
                Err(e) => println!("{url}: {e}"),
            }
        }
        assert!(probe.lookup(&probe.cfg.v4_trace).await.is_ok());
    }
}
