import { getAllMedia } from "@/lib/media-data";
import PhotosIndex from "@/components/PhotoTimeline";

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function PhotosPage({ searchParams }: PageProps) {
  const { page: pageParam } = await searchParams;
  const page = pageParam ? parseInt(pageParam) : 1;
  const { items, total, pageSize } = await getAllMedia(page);
  return <PhotosIndex items={items} total={total} page={page} pageSize={pageSize} />;
}
