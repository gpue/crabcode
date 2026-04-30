"use client";

import { useState } from "react";
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from "react-simple-maps";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

interface Location {
  id: string;
  label: string;
  lat: number;
  lng: number;
  date: string | Date;
  type: string;
  notes?: string | null;
  source: string;
}

interface WorldMapPageProps {
  locations: Location[];
}

const emptyForm = { label: "", lat: "", lng: "", date: "", type: "past", notes: "" };

export default function WorldMapPage({ locations: initial }: WorldMapPageProps) {
  const [locations, setLocations] = useState<Location[]>(initial);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [filterType, setFilterType] = useState<"all" | "past" | "future">("all");
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = locations.filter(
    (loc) => filterType === "all" || loc.type === filterType
  );

  function openAdd() {
    setForm(emptyForm);
    setEditingId(null);
    setShowAddForm(true);
    setError(null);
  }

  function openEdit(loc: Location) {
    setForm({
      label: loc.label,
      lat: String(loc.lat),
      lng: String(loc.lng),
      date: new Date(loc.date).toISOString().split("T")[0],
      type: loc.type,
      notes: loc.notes ?? "",
    });
    setEditingId(loc.id);
    setShowAddForm(true);
    setSelectedLocation(null);
    setError(null);
  }

  async function saveLocation() {
    const lat = parseFloat(form.lat);
    const lng = parseFloat(form.lng);
    if (!form.label || isNaN(lat) || isNaN(lng) || !form.date) {
      setError("Label, lat, lng and date are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        const res = await fetch("/api/locations", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, label: form.label, lat, lng, date: form.date, type: form.type, notes: form.notes || null }),
        });
        const updated = await res.json();
        setLocations((prev) => prev.map((l) => (l.id === editingId ? updated : l)));
      } else {
        const res = await fetch("/api/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: form.label, lat, lng, date: form.date, type: form.type, notes: form.notes || null, source: "manual" }),
        });
        const created = await res.json();
        setLocations((prev) => [...prev, created]);
      }
      setShowAddForm(false);
      setEditingId(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteLocation(id: string) {
    if (!confirm("Delete this location?")) return;
    await fetch("/api/locations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setLocations((prev) => prev.filter((l) => l.id !== id));
    if (selectedLocation?.id === id) setSelectedLocation(null);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 p-4 border-b border-gray-800">
        <h1 className="text-xl font-semibold">World Map</h1>
        <div className="flex gap-2 ml-auto">
          {(["all", "past", "future"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-3 py-1 rounded text-sm ${filterType === t ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-400">{filtered.length} locations</span>
        <button
          onClick={openAdd}
          className="px-3 py-1 rounded text-sm bg-green-700 hover:bg-green-600"
        >
          + Add
        </button>
      </div>

      <div className="flex-1 relative">
        <ComposableMap
          projectionConfig={{ scale: 150 }}
          style={{ width: "100%", height: "100%" }}
        >
          <ZoomableGroup>
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill="#1f2937"
                    stroke="#374151"
                    strokeWidth={0.5}
                  />
                ))
              }
            </Geographies>
            {filtered.map((loc) => (
              <Marker
                key={loc.id}
                coordinates={[loc.lng, loc.lat]}
                onClick={() => setSelectedLocation(loc === selectedLocation ? null : loc)}
              >
                {loc.type === "past" ? (
                  <circle r={4} fill="#3b82f6" stroke="#1d4ed8" strokeWidth={1} style={{ cursor: "pointer" }} />
                ) : (
                  <circle r={4} fill="transparent" stroke="#f59e0b" strokeWidth={2} style={{ cursor: "pointer" }} />
                )}
              </Marker>
            ))}
          </ZoomableGroup>
        </ComposableMap>

        {/* Location detail popover */}
        {selectedLocation && (
          <div className="absolute top-4 right-4 bg-gray-900 border border-gray-700 rounded-lg p-4 w-64 shadow-xl">
            <div className="flex justify-between items-start mb-2">
              <div className="font-medium">{selectedLocation.label}</div>
              <button onClick={() => setSelectedLocation(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="text-sm text-gray-400 space-y-1">
              <div>{new Date(selectedLocation.date).toLocaleDateString()}</div>
              <div>{selectedLocation.lat.toFixed(4)}, {selectedLocation.lng.toFixed(4)}</div>
              <div className="capitalize">{selectedLocation.type} · {selectedLocation.source}</div>
              {selectedLocation.notes && <div className="text-gray-500">{selectedLocation.notes}</div>}
            </div>
            <a
              href={`/dashboard/day?date=${new Date(selectedLocation.date).toISOString().split("T")[0]}`}
              className="mt-3 block text-center text-sm text-blue-400 hover:text-blue-300"
            >
              View Day →
            </a>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => openEdit(selectedLocation)}
                className="flex-1 text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600"
              >
                Edit
              </button>
              <button
                onClick={() => deleteLocation(selectedLocation.id)}
                className="flex-1 text-xs px-2 py-1 rounded bg-red-900 hover:bg-red-800"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {/* Add / Edit form */}
        {showAddForm && (
          <div className="absolute top-4 left-4 bg-gray-900 border border-gray-700 rounded-lg p-4 w-72 shadow-xl z-10">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-medium text-sm">{editingId ? "Edit Location" : "Add Location"}</h3>
              <button onClick={() => setShowAddForm(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-2 text-sm">
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                placeholder="Label"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
              <div className="flex gap-2">
                <input
                  className="w-1/2 bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                  placeholder="Latitude"
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                />
                <input
                  className="w-1/2 bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                  placeholder="Longitude"
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                />
              </div>
              <input
                type="date"
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
              <select
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              >
                <option value="past">Past</option>
                <option value="future">Future / Planned</option>
              </select>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
                placeholder="Notes (optional)"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button
                onClick={saveLocation}
                disabled={saving}
                className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : editingId ? "Update" : "Add Location"}
              </button>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-gray-900 bg-opacity-80 rounded p-2 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#3b82f6" /></svg>
            <span className="text-gray-300">Past</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="transparent" stroke="#f59e0b" strokeWidth="2" /></svg>
            <span className="text-gray-300">Future / Planned</span>
          </div>
        </div>
      </div>
    </div>
  );
}


const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

interface Location {
  id: string;
  label: string;
  lat: number;
  lng: number;
  date: string | Date;
  type: string;
  notes?: string | null;
  source: string;
}

interface WorldMapPageProps {
  locations: Location[];
}

export default function WorldMapPage({ locations }: WorldMapPageProps) {
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [filterType, setFilterType] = useState<"all" | "past" | "future">("all");

  const filtered = locations.filter(
    (loc) => filterType === "all" || loc.type === filterType
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 p-4 border-b border-gray-800">
        <h1 className="text-xl font-semibold">World Map</h1>
        <div className="flex gap-2 ml-auto">
          {(["all", "past", "future"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-3 py-1 rounded text-sm ${filterType === t ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"}`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-400">{filtered.length} locations</span>
      </div>

      <div className="flex-1 relative">
        <ComposableMap
          projectionConfig={{ scale: 150 }}
          style={{ width: "100%", height: "100%" }}
        >
          <ZoomableGroup>
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill="#1f2937"
                    stroke="#374151"
                    strokeWidth={0.5}
                  />
                ))
              }
            </Geographies>
            {filtered.map((loc) => (
              <Marker
                key={loc.id}
                coordinates={[loc.lng, loc.lat]}
                onClick={() => setSelectedLocation(loc === selectedLocation ? null : loc)}
              >
                {loc.type === "past" ? (
                  <circle r={4} fill="#3b82f6" stroke="#1d4ed8" strokeWidth={1} style={{ cursor: "pointer" }} />
                ) : (
                  <circle r={4} fill="transparent" stroke="#f59e0b" strokeWidth={2} style={{ cursor: "pointer" }} />
                )}
              </Marker>
            ))}
          </ZoomableGroup>
        </ComposableMap>

        {/* Popover */}
        {selectedLocation && (
          <div className="absolute top-4 right-4 bg-gray-900 border border-gray-700 rounded-lg p-4 w-64 shadow-xl">
            <div className="flex justify-between items-start mb-2">
              <div className="font-medium">{selectedLocation.label}</div>
              <button onClick={() => setSelectedLocation(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="text-sm text-gray-400 space-y-1">
              <div>{new Date(selectedLocation.date).toLocaleDateString()}</div>
              <div>{selectedLocation.lat.toFixed(4)}, {selectedLocation.lng.toFixed(4)}</div>
              <div className="capitalize">{selectedLocation.type} · {selectedLocation.source}</div>
              {selectedLocation.notes && <div className="text-gray-500">{selectedLocation.notes}</div>}
            </div>
            <a
              href={`/dashboard/day?date=${new Date(selectedLocation.date).toISOString().split("T")[0]}`}
              className="mt-3 block text-center text-sm text-blue-400 hover:text-blue-300"
            >
              View Day →
            </a>
          </div>
        )}

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-gray-900 bg-opacity-80 rounded p-2 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#3b82f6" /></svg>
            <span className="text-gray-300">Past</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="transparent" stroke="#f59e0b" strokeWidth="2" /></svg>
            <span className="text-gray-300">Future / Planned</span>
          </div>
        </div>
      </div>
    </div>
  );
}
