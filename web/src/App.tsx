import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Shell } from "./components/Shell";
import { AddConfirm } from "./views/AddConfirm";
import { Files } from "./views/Files";
import { Library } from "./views/Library";
import { Title } from "./views/Title";
import { Privacy } from "./views/Privacy";
import { Transfers } from "./views/Transfers";
import { Watch } from "./views/Watch";

export const routes = [
  {
    element: <Shell />,
    children: [
      { index: true, element: <Library /> },
      { path: "library", element: <Navigate to="/" replace /> },
      { path: "title/:key", element: <Title /> },
      { path: "files", element: <Files /> },
      { path: "transfers", element: <Transfers /> },
      { path: "privacy", element: <Privacy /> },
      { path: "watch/:tid/:fid", element: <Watch /> },
      { path: "add", element: <AddConfirm /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  // Navigation must feel instant: apply route changes synchronously instead
  // of inside a transition, which the 1.5 s transfer poll kept deferring.
  return <RouterProvider router={router} useTransitions={false} />;
}
