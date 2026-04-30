"use client";

import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard/day", label: "Today" },
  { href: "/dashboard/week", label: "Week" },
  { href: "/dashboard/month", label: "Month" },
  { href: "/dashboard/map", label: "World Map" },
  { href: "/dashboard/photos", label: "Photos" },
];

export default function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "?");
  }

  return (
    <nav className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col p-4 gap-1">
      {links.map(({ href, label }) => (
        <a
          key={href}
          href={href}
          className={`px-3 py-2 rounded text-sm ${
            isActive(href)
              ? "bg-gray-700 text-white"
              : "hover:bg-gray-800 text-gray-300"
          }`}
        >
          {label}
        </a>
      ))}
      <div className="flex-1" />
      <a
        href="/dashboard/settings"
        className={`px-3 py-2 rounded text-sm ${
          isActive("/dashboard/settings")
            ? "bg-gray-700 text-white"
            : "hover:bg-gray-800 text-gray-400"
        }`}
      >
        Settings
      </a>
    </nav>
  );
}
