"use client";

import { useEffect, useState } from "react";

import { useModules, moduleRouteAvailable } from "@/hooks/useModules";
import { useTranslation } from "react-i18next";
import { usePathname } from "next/navigation";

import { capabilityForPath } from "@/lib/capability-routes";

import { RequireCapability } from "./RequireCapability";

/**
 * Route-level gate: derives the required model capability from the current
 * pathname and locks the page when the user lacks it. Mounted once per authed
 * layout group, so direct-URL access to a gated feature is covered too.
 *
 * Children render immediately; the module gate is applied once inventory
 * loads. This avoids blocking the entire shell on /api/modules.
 */
export default function CapabilityGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const capability = capabilityForPath(pathname);
  const { modules, error, reload } = useModules();
  const { t } = useTranslation();
  const [gated, setGated] = useState(false);

  if (error) return <button onClick={reload}>{t("Retry")}</button>;

  useEffect(() => {
    if (modules !== null) {
      setGated(!moduleRouteAvailable(pathname, modules));
    }
  }, [modules, pathname]);

  if (gated) {
    return <p className="p-6">{t("This module is not installed or is disabled.")}</p>;
  }
  return <RequireCapability capability={capability}>{children}</RequireCapability>;
}
