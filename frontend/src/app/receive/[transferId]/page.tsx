import ReceiverPanel from "@/components/receiver-panel";

export default async function ReceivePage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const { transferId } = await params;
  return <ReceiverPanel transferId={transferId} />;
}
