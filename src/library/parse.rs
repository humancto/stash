//! File name → what it is: a film, an episode, or something else (samples,
//! extras, non-video files). Pure and table-tested; no regex crate, the
//! rules work on tokens.
//!
//! Approach: strip site prefixes and leading release-group brackets, split
//! into tokens, find the first "boundary" token (episode marker, release
//! tag, bracket block), and take the title from the tokens before it, with
//! the last plausible year as the film's year.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Film,
    Episode,
    /// Samples, extras, non-video files.
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Quality {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hdr: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalId {
    Imdb(String),
    Tmdb(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub kind: Kind,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u32>,
    /// Episode numbers (several for multi-episode files). With no season,
    /// they are absolute numbers (anime).
    pub episodes: Vec<u32>,
    /// `YYYY-MM-DD` for daily shows.
    pub date: Option<String>,
    pub quality: Quality,
    pub id: Option<ExternalId>,
}

const VIDEO_EXT: &[&str] = &[
    "mkv", "mp4", "m4v", "avi", "mov", "wmv", "webm", "ts", "m2ts", "mpg", "mpeg", "flv", "ogv",
];

pub fn is_video(name: &str) -> bool {
    extension(name).is_some_and(|e| VIDEO_EXT.contains(&e.as_str()))
}

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| ext.to_ascii_lowercase())
}

fn strip_extension(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((stem, _)) if extension(name).is_some_and(|e| VIDEO_EXT.contains(&e.as_str())) => stem,
        Some((stem, ext))
            if matches!(
                ext.to_ascii_lowercase().as_str(),
                "srt" | "ass" | "ssa" | "vtt" | "sub"
            ) =>
        {
            stem
        }
        _ => name,
    }
}

/// Folder names that hold extras, not the main feature.
const EXTRA_FOLDERS: &[&str] = &[
    "sample",
    "samples",
    "extras",
    "extra",
    "featurettes",
    "featurette",
    "behind the scenes",
    "deleted scenes",
    "trailers",
    "trailer",
    "interviews",
    "specials features",
    "bonus",
];

/// Does `s` look like a domain (`www.x.com`, `TamilRockers.ws`, `YTS.MX`)?
fn looks_like_domain(s: &str) -> bool {
    let s = s.trim().trim_matches(|c| c == '[' || c == ']' || c == ' ');
    if s.contains(' ') || !s.contains('.') {
        return false;
    }
    let Some((_, tld)) = s.rsplit_once('.') else {
        return false;
    };
    (2..=8).contains(&tld.len())
        && tld.chars().all(|c| c.is_ascii_alphabetic())
        && s.split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// Remove `www.site.com - `, `[www.site.com] - `, `[ OxTorrent.com ] `,
/// and a leading `[Group]` (anime). Returns the rest and whether a group
/// bracket was removed.
fn strip_prefixes(mut s: &str) -> (&str, bool) {
    let mut group = false;
    loop {
        let t = s.trim_start();
        if let Some(rest) = t.strip_prefix('[')
            && let Some(end) = rest.find(']')
        {
            let inner = &rest[..end];
            let after = rest[end + 1..].trim_start();
            let after = after.strip_prefix('-').unwrap_or(after);
            if looks_like_domain(inner) {
                s = after;
                continue;
            }
            // A release group before the title (anime): `[SubsPlease] X`.
            if !inner.is_empty() && inner.len() <= 32 && !after.trim().is_empty() {
                s = after;
                group = true;
                continue;
            }
        }
        if let Some((head, rest)) = t.split_once(" - ")
            && looks_like_domain(head)
        {
            s = rest;
            continue;
        }
        return (t, group);
    }
}

#[derive(Debug, Clone)]
struct Tok {
    text: String,
    /// Written in (), [] or {} in the name.
    wrapped: bool,
}

fn tokenize(s: &str) -> Vec<Tok> {
    let spaced = s.contains(' ');
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth: Option<char> = None;
    let push = |cur: &mut String, out: &mut Vec<Tok>, wrapped: bool| {
        let t = cur.trim();
        if !t.is_empty() {
            out.push(Tok {
                text: t.to_string(),
                wrapped,
            });
        }
        cur.clear();
    };
    for c in s.chars() {
        if let Some(close) = depth {
            if c == close {
                push(&mut cur, &mut out, true);
                depth = None;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '(' | '[' | '{' => {
                push(&mut cur, &mut out, false);
                depth = Some(match c {
                    '(' => ')',
                    '[' => ']',
                    _ => '}',
                });
            }
            '_' => push(&mut cur, &mut out, false),
            '.' if !spaced => push(&mut cur, &mut out, false),
            c if c.is_whitespace() => push(&mut cur, &mut out, false),
            c => cur.push(c),
        }
    }
    push(&mut cur, &mut out, depth.is_some());
    // Rejoin acronyms split on dots: S W A T → S.W.A.T
    let mut merged: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < out.len() {
        let single = |t: &Tok| {
            !t.wrapped && t.text.len() == 1 && t.text.chars().all(|c| c.is_ascii_alphabetic())
        };
        let mut j = i;
        while j < out.len() && single(&out[j]) {
            j += 1;
        }
        if !spaced && j - i >= 2 {
            let text = out[i..j]
                .iter()
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>()
                .join(".");
            merged.push(Tok {
                text,
                wrapped: false,
            });
            i = j;
        } else {
            merged.push(out[i].clone());
            i += 1;
        }
    }
    merged
}

fn current_year() -> u16 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Close enough for a plausibility bound.
    (1970 + secs / 31_556_952) as u16
}

fn as_year(t: &str) -> Option<u16> {
    let y: u16 = t.parse().ok().filter(|_| t.len() == 4)?;
    (1900..=current_year() + 1).contains(&y).then_some(y)
}

/// `S01E02`, `S01E02E03`, `S01E02-E03`, `S01E02-03`, `S04E28v2`, `S01`,
/// `S2024E01`. Returns (season, episodes).
fn season_episode(t: &str) -> Option<(u32, Vec<u32>)> {
    let b = t.as_bytes();
    if b.len() < 2 || !(b[0] == b'S' || b[0] == b's') || !b[1].is_ascii_digit() {
        return None;
    }
    let mut i = 1;
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i - start > 4 {
        return None;
    }
    let season: u32 = t[start..i].parse().ok()?;
    let mut eps = Vec::new();
    loop {
        // E, -E, or - followed by digits (only after a first episode)
        let mut j = i;
        if j < b.len() && b[j] == b'-' {
            j += 1;
        }
        let has_e = j < b.len() && (b[j] == b'E' || b[j] == b'e');
        if has_e {
            j += 1;
        } else if eps.is_empty() || j == i {
            break;
        }
        let d = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == d || j - d > 4 {
            break;
        }
        let n: u32 = t[d..j].parse().ok()?;
        // E01-03 is a range.
        if let (Some(&last), false) = (eps.last(), has_e) {
            if n > last && n - last <= 50 {
                eps.extend(last + 1..=n);
            }
        } else if let (Some(&last), true) = (eps.last(), b.get(i) == Some(&b'-')) {
            if n > last && n - last <= 50 {
                eps.extend(last + 1..=n);
            }
        } else {
            eps.push(n);
        }
        i = j;
    }
    // Trailing revision `v2` is fine; anything else means it wasn't a marker.
    let rest = &t[i..];
    let rest_ok = rest.is_empty()
        || ((rest.starts_with('v') || rest.starts_with('V'))
            && rest[1..].chars().all(|c| c.is_ascii_digit()));
    rest_ok.then_some((season, eps))
}

/// `1x02` (not `1920x1080`, `x264`).
fn cross_episode(t: &str) -> Option<(u32, u32)> {
    let (l, r) = t.split_once(['x', 'X'])?;
    if l.is_empty() || l.len() > 2 || !l.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !(2..=3).contains(&r.len()) || !r.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((l.parse().ok()?, r.parse().ok()?))
}

/// `12`, `1085`, `28v2` → the number (a trailing revision is dropped).
fn number(t: &str) -> Option<u32> {
    let digits = match t.find(['v', 'V']) {
        Some(i) if !t[i + 1..].is_empty() && t[i + 1..].chars().all(|c| c.is_ascii_digit()) => {
            &t[..i]
        }
        _ => t,
    };
    if digits.is_empty() || digits.len() > 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn lower(t: &str) -> String {
    t.to_ascii_lowercase()
}

fn resolution(l: &str) -> Option<&'static str> {
    Some(match l {
        "2160p" | "4k" | "uhd" => "2160p",
        "1440p" => "1440p",
        "1080p" | "1080i" => "1080p",
        "720p" => "720p",
        "576p" => "576p",
        "480p" => "480p",
        "360p" => "360p",
        _ => return None,
    })
}

fn source(l: &str) -> Option<&'static str> {
    Some(match l {
        "bluray" | "blu-ray" | "bdrip" | "brrip" | "bdremux" | "remux" => "BluRay",
        "web-dl" | "webdl" | "web" | "webrip" | "web-rip" => "WEB",
        "hdtv" | "pdtv" => "HDTV",
        "dvdrip" | "dvd" | "dvd5" | "dvd9" => "DVD",
        "hdrip" => "HDRip",
        "dvdscr" | "dvdscreener" | "scr" => "DVDScr",
        "cam" | "camrip" | "hdcam" => "CAM",
        "ts" | "hdts" | "telesync" | "hdtc" | "tc" | "telecine" => "TS",
        "predvd" | "s-print" | "hqprint" => "PreDVD",
        _ => return None,
    })
}

fn codec(l: &str) -> Option<&'static str> {
    Some(match l {
        "x264" | "h264" | "h.264" | "avc" => "H.264",
        "x265" | "h265" | "h.265" | "hevc" => "HEVC",
        "av1" => "AV1",
        "xvid" | "divx" => "XviD",
        _ => return None,
    })
}

fn language(l: &str) -> Option<&'static str> {
    Some(match l {
        "telugu" | "tel" => "te",
        "tamil" | "tam" => "ta",
        "hindi" | "hin" => "hi",
        "malayalam" | "mal" => "ml",
        "kannada" | "kan" => "kn",
        "bengali" => "bn",
        "marathi" => "mr",
        "english" | "eng" => "en",
        "japanese" | "jap" => "ja",
        "korean" => "ko",
        "spanish" => "es",
        "french" => "fr",
        "german" => "de",
        "italian" => "it",
        "multi" | "dual" => "multi",
        _ => return None,
    })
}

/// Tokens that end a title even when nothing else has (release tags).
fn is_tag(l: &str) -> bool {
    resolution(l).is_some()
        || source(l).is_some()
        || codec(l).is_some()
        || matches!(
            l,
            "hdr"
                | "hdr10"
                | "hdr10+"
                | "dv"
                | "dovi"
                | "10bit"
                | "8bit"
                | "imax"
                | "extended"
                | "unrated"
                | "remastered"
                | "uncut"
                | "repack"
                | "proper"
                | "internal"
                | "limited"
                | "complete"
                | "aac"
                | "ac3"
                | "dts"
                | "ddp"
                | "ddp5"
                | "dd5"
                | "atmos"
                | "truehd"
                | "esub"
                | "esubs"
                | "hq"
                | "true"
                | "nf"
                | "amzn"
                | "dsnp"
                | "hmax"
                | "atvp"
                | "criterion"
                | "readnfo"
                | "subbed"
                | "dubbed"
                | "org"
                | "multisub"
                | "sample"
        )
        || l.ends_with("gb")
            && l[..l.len() - 2]
                .replace('.', "")
                .chars()
                .all(|c| c.is_ascii_digit())
            && l.len() > 2
        || l.ends_with("mb")
            && l[..l.len() - 2]
                .replace('.', "")
                .chars()
                .all(|c| c.is_ascii_digit())
            && l.len() > 2
}

fn quality(toks: &[Tok]) -> Quality {
    let mut q = Quality::default();
    for t in toks {
        // Bracket blocks hold several tags: look inside.
        for part in t
            .text
            .split([' ', '.', '-', '_', ','])
            .filter(|p| !p.is_empty())
        {
            let l = lower(part);
            if q.resolution.is_none() {
                q.resolution = resolution(&l);
            }
            if q.codec.is_none() {
                q.codec = codec(&l);
            }
            if q.source.is_none() {
                q.source = source(&l);
            }
            if matches!(l.as_str(), "hdr" | "hdr10" | "hdr10+" | "dv" | "dovi") {
                q.hdr = true;
            }
            if let Some(lang) = language(&l)
                && !q.languages.contains(&lang)
            {
                q.languages.push(lang);
            }
        }
        // "WEB-DL", "H.264" as one token
        let l = lower(&t.text);
        if q.source.is_none() {
            q.source = source(&l);
        }
        if q.codec.is_none() {
            q.codec = codec(&l);
        }
    }
    q
}

fn external_id(name: &str) -> Option<ExternalId> {
    let l = name.to_ascii_lowercase();
    if let Some(i) = l.find("tmdb-").or_else(|| l.find("tmdbid-")) {
        let rest = &l[i..];
        let digits: String = rest
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse() {
            return Some(ExternalId::Tmdb(n));
        }
    }
    let b = l.as_bytes();
    let mut i = 0;
    while let Some(p) = l[i..].find("tt") {
        let s = i + p;
        let digits = b[s + 2..].iter().take_while(|c| c.is_ascii_digit()).count();
        let before_ok = s == 0 || !b[s - 1].is_ascii_alphanumeric();
        if (7..=8).contains(&digits) && before_ok {
            return Some(ExternalId::Imdb(l[s..s + 2 + digits].to_string()));
        }
        i = s + 2;
    }
    None
}

/// What made the title end.
enum Marker {
    Episode {
        season: Option<u32>,
        episodes: Vec<u32>,
    },
    Date(String),
}

fn find_marker(toks: &[Tok]) -> Option<(usize, Marker)> {
    for (i, t) in toks.iter().enumerate() {
        if t.wrapped {
            continue;
        }
        if let Some((s, e)) = season_episode(&t.text) {
            return Some((
                i,
                Marker::Episode {
                    season: Some(s),
                    episodes: e,
                },
            ));
        }
        if let Some((s, e)) = cross_episode(&t.text) {
            return Some((
                i,
                Marker::Episode {
                    season: Some(s),
                    episodes: vec![e],
                },
            ));
        }
        let l = lower(&t.text);
        // "Season 1", "Season 1 Episode 2"
        if l == "season"
            && let Some(s) = toks.get(i + 1).and_then(|n| number(&n.text))
        {
            let ep = (toks.get(i + 2).map(|t| lower(&t.text)).as_deref() == Some("episode"))
                .then(|| toks.get(i + 3).and_then(|n| number(&n.text)))
                .flatten();
            return Some((
                i,
                Marker::Episode {
                    season: Some(s),
                    episodes: ep.into_iter().collect(),
                },
            ));
        }
        // Daily shows: 2024 03 14
        if let (Some(y), Some(m), Some(d)) = (as_year(&t.text), toks.get(i + 1), toks.get(i + 2)) {
            let two = |s: &str, max: u32| {
                s.len() == 2 && s.parse::<u32>().is_ok_and(|n| (1..=max).contains(&n))
            };
            if i > 0 && two(&m.text, 12) && two(&d.text, 31) {
                return Some((i, Marker::Date(format!("{y}-{}-{}", m.text, d.text))));
            }
        }
        // Anime: "Title - 12", "Title - 1085 [1080p]", also without a group
        // when the number can't be a year.
        if t.text == "-"
            && i > 0
            && let Some(next) = toks.get(i + 1)
            && !next.wrapped
            && let Some(n) = number(&next.text)
        {
            // A year after the dash is a year, not an episode.
            if n > 0 && as_year(&next.text).is_none() {
                return Some((
                    i,
                    Marker::Episode {
                        season: None,
                        episodes: vec![n],
                    },
                ));
            }
        }
    }
    None
}

fn title_case_if_lower(s: String) -> String {
    if s.chars().any(|c| c.is_uppercase()) {
        return s;
    }
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn join_title(toks: &[Tok]) -> String {
    let mut words: Vec<&str> = toks.iter().map(|t| t.text.as_str()).collect();
    while words.last().is_some_and(|w| *w == "-" || *w == "–") {
        words.pop();
    }
    while words.first().is_some_and(|w| *w == "-" || *w == "–") {
        words.remove(0);
    }
    let s = words.join(" ");
    title_case_if_lower(s.trim().to_string())
}

/// Parse one name (a file name or a folder name).
pub fn parse_name(name: &str) -> Parsed {
    let id = external_id(name);
    let stem = strip_extension(name);
    let (rest, _group) = strip_prefixes(stem);
    let toks = tokenize(rest);

    let marker = find_marker(&toks);
    let lowers: Vec<String> = toks.iter().map(|t| lower(&t.text)).collect();
    // First release tag, or the first bracket block after the start (which
    // holds tags or a group).
    let tag_at = toks
        .iter()
        .enumerate()
        .position(|(i, t)| {
            // Any bracket block after the start, except a year, ends the
            // title (it holds tags or a group); so does a bare release tag.
            (i > 0 && t.wrapped && as_year(&t.text).is_none()) || (!t.wrapped && is_tag(&lowers[i]))
        })
        .unwrap_or(toks.len());
    let marker_at = marker.as_ref().map_or(toks.len(), |(i, _)| *i);
    let end = tag_at.min(marker_at);
    let head = &toks[..end];

    let mut year = None;
    let mut title_end = end;
    // A year in () or [] anywhere before the boundary wins.
    if let Some(i) = head
        .iter()
        .rposition(|t| t.wrapped && as_year(&t.text).is_some())
    {
        year = as_year(&head[i].text);
        title_end = i;
    } else if marker.is_none() {
        // Films: the last bare year, but never the only word ("1917").
        if let Some(i) = head.iter().rposition(|t| as_year(&t.text).is_some())
            && i > 0
        {
            year = as_year(&head[i].text);
            title_end = i;
        }
    } else if matches!(marker, Some((_, Marker::Date(_)))) {
        // The date's year is not the show's.
    }
    let title_toks: Vec<Tok> = head[..title_end]
        .iter()
        .filter(|t| !(t.wrapped && as_year(&t.text).is_some()))
        // CD1 / Disc 2 belong to one film.
        .filter(|t| {
            let l = lower(&t.text);
            !(l.starts_with("cd") && l[2..].chars().all(|c| c.is_ascii_digit()) && l.len() > 2)
        })
        .cloned()
        .collect();
    let title = join_title(&title_toks);

    let sample = lowers.iter().any(|l| l == "sample" || l == "trailer");
    let (kind, season, episodes, date) = match marker {
        Some((_, Marker::Episode { season, episodes })) => (Kind::Episode, season, episodes, None),
        Some((_, Marker::Date(d))) => (Kind::Episode, None, Vec::new(), Some(d)),
        None => (Kind::Film, None, Vec::new(), None),
    };
    Parsed {
        kind: if sample { Kind::Other } else { kind },
        title,
        year,
        season,
        episodes,
        date,
        quality: quality(&toks[end.min(toks.len())..]),
        id,
    }
}

/// A file name of random characters (`a1b2c3d4e5.mkv`): use the folder.
fn obfuscated(title: &str) -> bool {
    let t = title.trim();
    !t.contains(' ')
        && t.len() >= 8
        && t.chars().all(|c| c.is_ascii_alphanumeric())
        && t.chars().filter(|c| c.is_ascii_digit()).count() >= 3
}

fn season_folder(name: &str) -> Option<u32> {
    let l = name.trim().to_ascii_lowercase();
    let rest = l
        .strip_prefix("season")
        .or_else(|| l.strip_prefix("series"))?;
    let rest = rest.trim_start_matches([' ', '.', '_']);
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty() && digits.len() == rest.len())
        .then(|| digits.parse().ok())
        .flatten()
        .or_else(|| {
            // "S01"
            season_episode(name.trim())
                .filter(|(_, e)| e.is_empty())
                .map(|(s, _)| s)
        })
}

/// Parse a file of a transfer: `components` is its path inside the
/// torrent (folders then the file name). Folders give context: the show
/// for `Show/Season 1/02 - Title.mkv`, the film for obfuscated names, and
/// extras folders.
pub fn parse_file(components: &[String]) -> Parsed {
    let Some(file) = components.last() else {
        return parse_name("");
    };
    let folders = &components[..components.len() - 1];
    let mut p = parse_name(file);
    if !is_video(file) {
        p.kind = Kind::Other;
        return p;
    }
    if folders
        .iter()
        .any(|f| EXTRA_FOLDERS.contains(&f.trim().to_ascii_lowercase().as_str()))
    {
        p.kind = Kind::Other;
        return p;
    }
    // Folders from the innermost out, skipping "Season N".
    let season_dir = folders.iter().rev().find_map(|f| season_folder(f));
    let named_folder = folders.iter().rev().find(|f| season_folder(f).is_none());

    // `02 - Title.mkv` / `Episode 2.mkv` under a season folder.
    if p.kind == Kind::Film
        && let Some(season) = season_dir
    {
        let stem = strip_extension(file);
        let lead: String = stem
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let ep = if !lead.is_empty() && lead.len() <= 3 {
            lead.parse().ok()
        } else {
            stem.to_ascii_lowercase()
                .strip_prefix("episode")
                .and_then(|r| r.trim().parse().ok())
        };
        if let Some(ep) = ep {
            p.kind = Kind::Episode;
            p.season = Some(season);
            p.episodes = vec![ep];
            p.title.clear();
        }
    }
    let needs_folder = p.title.is_empty() || obfuscated(&p.title);
    if needs_folder && let Some(folder) = named_folder {
        let f = parse_name(folder);
        p.title = f.title;
        if p.year.is_none() {
            p.year = f.year;
        }
        if p.kind == Kind::Film && f.kind == Kind::Episode {
            // Obfuscated file inside an episode folder.
            p.kind = Kind::Episode;
            p.season = f.season;
            p.episodes = f.episodes;
        }
        if p.quality == Quality::default() {
            p.quality = f.quality;
        }
        if p.id.is_none() {
            p.id = f.id;
        }
    }
    if p.kind == Kind::Episode && p.season.is_none() && p.date.is_none() {
        p.season = season_dir.filter(|_| !p.episodes.is_empty() && p.episodes[0] < 200);
    }
    p
}

/// FNV-1a: stable across Rust versions (unlike `DefaultHasher`).
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// The Library key for a parsed file: `film-<slug>[-<year>]`,
/// `show-<slug>[-<year>]`; `[a-z0-9-]` only. Titles with no ASCII letters
/// use a stable hash.
pub fn title_key(p: &Parsed) -> Option<String> {
    let kind = match p.kind {
        Kind::Film => "film",
        Kind::Episode => "show",
        Kind::Other => return None,
    };
    let s = slug(&p.title);
    let s = if s.chars().any(|c| c.is_ascii_alphabetic()) || (!s.is_empty() && p.title.is_ascii()) {
        s
    } else if p.title.trim().is_empty() {
        return None;
    } else {
        format!("t-{:x}", fnv1a(&p.title.to_lowercase()))
    };
    Some(match p.year {
        Some(y) => format!("{kind}-{s}-{y}"),
        None => format!("{kind}-{s}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Want {
        kind: Kind,
        title: &'static str,
        year: Option<u16>,
        season: Option<u32>,
        episodes: &'static [u32],
    }
    const fn film(title: &'static str, year: Option<u16>) -> Want {
        Want {
            kind: Kind::Film,
            title,
            year,
            season: None,
            episodes: &[],
        }
    }
    const fn ep(title: &'static str, season: Option<u32>, episodes: &'static [u32]) -> Want {
        Want {
            kind: Kind::Episode,
            title,
            year: None,
            season,
            episodes,
        }
    }

    fn check(path: &str, want: Want) {
        let comps: Vec<String> = path.split('/').map(str::to_string).collect();
        let p = parse_file(&comps);
        assert_eq!(
            (
                p.kind,
                p.title.as_str(),
                p.year,
                p.season,
                p.episodes.as_slice()
            ),
            (want.kind, want.title, want.year, want.season, want.episodes),
            "{path}: {p:?}"
        );
    }

    #[test]
    fn films() {
        let cases: &[(&str, Want)] = &[
            (
                "www.5MovieRulz.company - Aadarsha Kutumbam House No 47 (2026) 1080p Telugu DVDScr - x264 - AAC - 2.6GB.mkv",
                film("Aadarsha Kutumbam House No 47", Some(2026)),
            ),
            (
                "[www.TamilBlasters.xyz] - Kanguva (2024) [Tamil - 1080p HQ HDRip - x264 - AAC - 2.4GB].mkv",
                film("Kanguva", Some(2024)),
            ),
            (
                "www.1TamilMV.world - Devara (2025) Telugu TRUE WEB-DL - 1080p - AVC - (DD+5.1 - 640Kbps & AAC) - 2.5GB - ESub.mkv",
                film("Devara", Some(2025)),
            ),
            (
                "TamilRockers.ws - Leo (2023) 720p.mkv",
                film("Leo", Some(2023)),
            ),
            (
                "[ OxTorrent.com ] Le Film (2019) FRENCH 1080p.mkv",
                film("Le Film", Some(2019)),
            ),
            (
                "Mission.Impossible.Fallout.2018.1080p.BluRay.x264.mkv",
                film("Mission Impossible Fallout", Some(2018)),
            ),
            (
                "Star Wars - Episode IV - A New Hope (1977).mkv",
                film("Star Wars - Episode IV - A New Hope", Some(1977)),
            ),
            (
                "2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.x265.HDR.mkv",
                film("2001 A Space Odyssey", Some(1968)),
            ),
            ("1917.2019.1080p.mkv", film("1917", Some(2019))),
            ("2012.2009.720p.mkv", film("2012", Some(2009))),
            ("1984.1984.mkv", film("1984", Some(1984))),
            (
                "Blade.Runner.2049.2017.1080p.mkv",
                film("Blade Runner 2049", Some(2017)),
            ),
            (
                "Wonder.Woman.1984.2020.mkv",
                film("Wonder Woman 1984", Some(2020)),
            ),
            (
                "Pushpa 2 The Rule (2024).mkv",
                film("Pushpa 2 The Rule", Some(2024)),
            ),
            ("Se7en.1995.mkv", film("Se7en", Some(1995))),
            ("300 (2006).mkv", film("300", Some(2006))),
            ("Apollo 13.mkv", film("Apollo 13", None)),
            (
                "21 Jump Street (2012) 1080p.mkv",
                film("21 Jump Street", Some(2012)),
            ),
            (
                "RRR (2022) Telugu Hindi Tamil Multi Audio.mkv",
                film("RRR", Some(2022)),
            ),
            (
                "Mr. & Mrs. Smith (2024).mkv",
                film("Mr. & Mrs. Smith", Some(2024)),
            ),
            ("M.A.S.H.1970.mkv", film("M.A.S.H", Some(1970))),
            (
                "Dune.Part.Two.2024.IMAX.1080p.mkv",
                film("Dune Part Two", Some(2024)),
            ),
            (
                "Avengers Endgame (2019) [1080p] [YTS.MX].mp4",
                film("Avengers Endgame", Some(2019)),
            ),
            ("Movie Name [2019].mkv", film("Movie Name", Some(2019))),
            (
                "Movie.Name.(2019).[1080p].mkv",
                film("Movie Name", Some(2019)),
            ),
            ("Amélie.2001.mkv", film("Amélie", Some(2001))),
            (
                "千と千尋の神隠し (2001).mkv",
                film("千と千尋の神隠し", Some(2001)),
            ),
            ("Movie.CD1.avi", film("Movie", None)),
            (
                "Real.Title.2019.1080p/a1b2c3d4e5f6.mkv",
                film("Real Title", Some(2019)),
            ),
            (
                "Big Buck Bunny/Big Buck Bunny.mp4",
                film("Big Buck Bunny", None),
            ),
        ];
        for (path, want) in cases {
            check(path, Want { ..*want });
        }
    }

    #[test]
    fn episodes() {
        let cases: &[(&str, Want)] = &[
            ("Space.1999.S01E01.mkv", ep("Space 1999", Some(1), &[1])),
            ("The.4400.S01E01.mkv", ep("The 4400", Some(1), &[1])),
            (
                "Doctor.Who.2005.S13E01.mkv",
                ep("Doctor Who 2005", Some(13), &[1]),
            ),
            (
                "[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv",
                ep("Sousou no Frieren", None, &[12]),
            ),
            (
                "[Erai-raws] One Piece - 1085 [1080p][Multiple Subtitle].mkv",
                ep("One Piece", None, &[1085]),
            ),
            (
                "[Judas] Shingeki no Kyojin - S04E28v2 [HEVC x265 10bit].mkv",
                ep("Shingeki no Kyojin", Some(4), &[28]),
            ),
            (
                "Detective Conan - 1100.mkv",
                ep("Detective Conan", None, &[1100]),
            ),
            (
                "Naruto Shippuden - 500.mkv",
                ep("Naruto Shippuden", None, &[500]),
            ),
            (
                "The.Office.US.S05E14-E15.mkv",
                ep("The Office US", Some(5), &[14, 15]),
            ),
            ("Friends.S01E01E02.mkv", ep("Friends", Some(1), &[1, 2])),
            ("Show.S01E01-02.mkv", ep("Show", Some(1), &[1, 2])),
            ("Show.S01E01-E03.mkv", ep("Show", Some(1), &[1, 2, 3])),
            ("Show - 1x01 - Pilot.avi", ep("Show", Some(1), &[1])),
            (
                "Game.of.Thrones.S01.COMPLETE.1080p.BluRay.x265-RARBG/Game.of.Thrones.S01E01.Winter.Is.Coming.mkv",
                ep("Game of Thrones", Some(1), &[1]),
            ),
            (
                "The Wire/Season 01/02 - The Detail.mkv",
                ep("The Wire", Some(1), &[2]),
            ),
            (
                "Some Show/Season 1/Episode 2.mkv",
                ep("Some Show", Some(1), &[2]),
            ),
            ("Sherlock.S00E01.mkv", ep("Sherlock", Some(0), &[1])),
            (
                "MasterChef.S2024E01.mkv",
                ep("MasterChef", Some(2024), &[1]),
            ),
            (
                "Stranger.Things.S04E01.REPACK.PROPER.1080p.NF.WEB-DL.DDP5.1.Atmos.HDR.DV.HEVC-Group.mkv",
                ep("Stranger Things", Some(4), &[1]),
            ),
            ("S.W.A.T.2017.S01E01.mkv", ep("S.W.A.T 2017", Some(1), &[1])),
            (
                "Marvel's.Agents.of.S.H.I.E.L.D.S01E01.mkv",
                ep("Marvel's Agents of S.H.I.E.L.D", Some(1), &[1]),
            ),
        ];
        for (path, want) in cases {
            check(path, Want { ..*want });
        }
        let d = parse_file(&["the.daily.show.2024.03.14.guest.1080p.WEB.h264.mkv".into()]);
        assert_eq!(
            (d.kind, d.title.as_str(), d.date.as_deref()),
            (Kind::Episode, "The Daily Show", Some("2024-03-14"))
        );
    }

    #[test]
    fn other_and_negatives() {
        for path in [
            "Movie.Name.2020.Sample.mkv",
            "Movie (2020)/Featurettes/Making Of.mkv",
            "Movie (2020)/Behind The Scenes/Clip.mkv",
            "Movie (2020)/RARBG.txt",
            "Movie (2020)/Movie.nfo",
            "Movie (2020)/Movie.en.srt",
        ] {
            let comps: Vec<String> = path.split('/').map(str::to_string).collect();
            assert_eq!(parse_file(&comps).kind, Kind::Other, "{path}");
        }
        // Not episodes
        assert_eq!(cross_episode("1920x1080"), None);
        assert_eq!(cross_episode("x264"), None);
        assert_eq!(parse_name("Movie.1920x1080.mkv").kind, Kind::Film);
        assert_eq!(
            parse_name("10 Things I Hate About You (1999).mkv").title,
            "10 Things I Hate About You"
        );
    }

    #[test]
    fn quality_and_ids() {
        let p = parse_name(
            "www.5MovieRulz.company - Aadarsha Kutumbam House No 47 (2026) 1080p Telugu DVDScr - x264 - AAC - 2.6GB.mkv",
        );
        assert_eq!(p.quality.resolution, Some("1080p"));
        assert_eq!(p.quality.source, Some("DVDScr"));
        assert_eq!(p.quality.codec, Some("H.264"));
        assert_eq!(p.quality.languages, vec!["te"]);
        let p = parse_name("2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.x265.HDR.mkv");
        assert_eq!(
            (p.quality.resolution, p.quality.hdr, p.quality.codec),
            (Some("2160p"), true, Some("HEVC"))
        );
        assert_eq!(
            parse_name("Film (1999) tt0133093.mkv").id,
            Some(ExternalId::Imdb("tt0133093".into()))
        );
        assert_eq!(
            parse_name("Film (1999) {tmdb-603}.mkv").id,
            Some(ExternalId::Tmdb(603))
        );
    }

    #[test]
    fn keys() {
        let k = |s: &str| title_key(&parse_name(s));
        assert_eq!(
            k("Blade.Runner.2049.2017.mkv").as_deref(),
            Some("film-blade-runner-2049-2017")
        );
        assert_eq!(k("Friends.S01E01.mkv").as_deref(), Some("show-friends"));
        assert_eq!(
            k("Mr. & Mrs. Smith (2024).mkv").as_deref(),
            Some("film-mr-mrs-smith-2024")
        );
        let jp = k("千と千尋の神隠し (2001).mkv").unwrap();
        assert!(jp.starts_with("film-t-") && jp.ends_with("-2001"), "{jp}");
        assert!(
            jp.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        );
        assert_eq!(k("Movie.Sample.mkv"), None);
        assert_eq!(fnv1a("a"), 0xaf63_dc4c_8601_ec8c);
    }
}
