export type DomainEvent = {
  eventId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
