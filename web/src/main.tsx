import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./styles.css";
import { AppShell } from "./components/Shell";
import { ForgotPassword, ResetPassword, SignIn, SignUp } from "./pages/Auth";
import { Library } from "./pages/Library";
import { Search } from "./pages/Search";
import { ItemDetail } from "./pages/ItemDetail";
import { Collections } from "./pages/Collections";
import { Account } from "./pages/Account";
import { Welcome } from "./pages/Welcome";
import { Help, Landing, NotFound, Pricing, Privacy } from "./pages/Public";

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },
  { path: "/pricing", element: <Pricing /> },
  { path: "/privacy", element: <Privacy /> },
  { path: "/help", element: <Help /> },
  { path: "/sign-in", element: <SignIn /> },
  { path: "/sign-up", element: <SignUp /> },
  { path: "/forgot-password", element: <ForgotPassword /> },
  { path: "/reset-password", element: <ResetPassword /> },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      { index: true, element: <Library /> },
      { path: "welcome", element: <Welcome /> },
      { path: "search", element: <Search /> },
      { path: "items/:id", element: <ItemDetail /> },
      { path: "collections", element: <Collections /> },
      { path: "account", element: <Account /> },
    ],
  },
  { path: "*", element: <NotFound /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
