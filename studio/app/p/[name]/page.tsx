import StudioApp from "@/components/StudioApp";

export default async function ProjectPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <StudioApp projectName={name} />;
}
