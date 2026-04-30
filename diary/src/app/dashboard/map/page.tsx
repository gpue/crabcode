import { getAllLocations } from "@/lib/location-data";
import WorldMapPage from "@/components/WorldMap";

export default async function MapPage() {
  const locations = await getAllLocations();
  return <WorldMapPage locations={locations} />;
}
