import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidebarShell } from "@/components/sidebar/SidebarShell";

const fixture = vi.hoisted(() => ({
  push: vi.fn(),
  close: vi.fn(),
  sidebarCollapsed: false,
  pathname: "/chat",
}));

vi.mock("@/hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    enabled: false,
    authenticated: false,
    isAdmin: false,
    userId: null,
    statusAvailable: true,
    loading: false,
    learningPolicy: null,
  }),
}));

vi.mock("@/hooks/useChatWorkspaces", () => ({
  useChatWorkspaces: () => ({ workspaces: [], error: "" }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => fixture.pathname,
  useRouter: () => ({ push: fixture.push }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/context/AppShellContext", () => ({
  useAppShell: () => ({
    sidebarCollapsed: fixture.sidebarCollapsed,
    setSidebarCollapsed: vi.fn(),
  }),
}));
vi.mock("@/components/layout/AppShell", () => ({
  useSidebarDrawer: () => ({ close: fixture.close }),
}));
vi.mock("@/hooks/useDevice", () => ({
  useDevice: () => ({ isMobile: false }),
}));
vi.mock("@/components/sidebar/VersionBadge", () => ({
  VersionBadge: () => null,
}));
vi.mock("@/components/sidebar/LearningNavigation", () => ({
  LearningNavigation: () => <div>learning shelf</div>,
}));
vi.mock("@/components/sidebar/PartnerNavigation", () => ({
  PartnerNavigation: () => <div>partners shelf</div>,
}));
vi.mock("@/components/sidebar/ResourcesNavigation", () => ({
  ResourcesNavigation: () => <div>resources shelf</div>,
  PersonalizationNavigation: () => <div>personalization shelf</div>,
}));

it("keeps every shelf in the rail beside the open panel", () => {
  const { container } = render(<SidebarShell />);

  const rail = container.querySelector(".dt-sidebar-rail");
  const panel = container.querySelector(".dt-sidebar-panel");
  expect(rail).toBeInTheDocument();
  expect(panel).toBeInTheDocument();
  expect(rail!.parentElement).toBe(panel!.parentElement);

  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
    "navigation.home",
    "navigation.learning",
    "navigation.resources",
    "navigation.partners",
    "navigation.personalization",
  ]);
  expect(tabs.every((tab) => rail!.contains(tab))).toBe(true);
  expect(screen.getByRole("tablist", { name: "navigation.categories" })).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  const tabpanel = screen.getByRole("tabpanel");
  expect(tabpanel).toHaveAttribute("aria-labelledby", "category-home");

  for (const [name, href] of [
    ["Calendar", "/calendar"],
    ["Task Board", "/kanban"],
    ["Co-Writer", "/co-writer"],
  ]) {
    const link = screen.getByRole("link", { name });
    expect(rail).toContainElement(link);
    expect(link).toHaveAttribute("href", href);
    expect(within(tabpanel).queryByRole("link", { name })).toBeNull();
  }
});

it("marks the workspace tool that owns the current page", () => {
  fixture.pathname = "/calendar";
  render(<SidebarShell />);

  expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: "Task Board" })).not.toHaveAttribute(
    "aria-current",
  );
  fixture.pathname = "/chat";
});

it("opens the shelf page and swaps the panel from the rail", async () => {
  render(<SidebarShell />);

  fireEvent.click(screen.getByRole("tab", { name: "navigation.resources" }));

  expect(await screen.findByText("resources shelf")).toBeInTheDocument();
  expect(fixture.push).toHaveBeenCalledWith("/space?dt_workspace=");
  expect(screen.getByRole("tab", { name: "navigation.resources" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "category-resources",
  );
});

it("moves rail focus with arrows without opening a shelf", () => {
  render(<SidebarShell />);
  const home = screen.getByRole("tab", { name: "navigation.home" });
  const learning = screen.getByRole("tab", { name: "navigation.learning" });

  act(() => home.focus());
  fireEvent.keyDown(home, { key: "ArrowDown" });

  expect(learning).toHaveFocus();
  expect(fixture.push).not.toHaveBeenCalled();
});

it("folds to the rail alone when the panel is collapsed", () => {
  fixture.sidebarCollapsed = true;
  const { container } = render(<SidebarShell />);

  expect(container.querySelector(".dt-sidebar-panel")).toBeNull();
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  expect(screen.getAllByRole("tab")).toHaveLength(5);
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
  fixture.sidebarCollapsed = false;
});
