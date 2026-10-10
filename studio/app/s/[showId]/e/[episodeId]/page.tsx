import StudioApp from "@/components/StudioApp";

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ showId: string; episodeId: string }>;
}) {
  const { showId, episodeId } = await params;
  return <StudioApp projectName={episodeId} showId={showId} />;
}
