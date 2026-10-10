import ShowScreen from "@/components/ShowScreen";

export default async function ShowPage({ params }: { params: Promise<{ showId: string }> }) {
  const { showId } = await params;
  return <ShowScreen showId={showId} />;
}
