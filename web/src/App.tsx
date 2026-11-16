import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Shell } from "./components/Shell";
import { Files } from "./views/Files";
import { Privacy } from "./views/Privacy";
import { Transfers } from "./views/Transfers";
import { Watch } from "./views/Watch";

export const routes = [
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/files" replace /> },
      { path: "files", element: <Files /> },
      { path: "transfers", element: <Transfers /> },
      { path: "privacy", element: <Privacy /> },
      { path: "watch/:tid/:fid", element: <Watch /> },
      { path: "*", element: <Navigate to="/files" replace /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  // Navigation must feel instant: apply route changes synchronously instead
  // of inside a transition, which the 1.5 s transfer poll kept deferring.
  return <RouterProvider router={router} useTransitions={false} />;
}
