export interface ClickHousePingClient {
  ping(params: {
    select: true;
  }): Promise<{ success: true } | { success: false; error: Error }>;
}

export async function assertClickHouseReady(
  client: ClickHousePingClient,
): Promise<void> {
  const result = await client.ping({ select: true });
  if (!result.success) throw result.error;
}
