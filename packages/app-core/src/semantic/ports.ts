/** A connection kept for turning text into vectors. */
export type EmbeddingConnection = { id: string; model: string; label?: string };

/**
 * Where the application gets vectors from. The default reads the embedding connections the user configured; tests give a controlled one.
 * Vectors for one model all have the same length, and vectors of different models are never compared.
 */
export type EmbeddingPort = {
  /** The connection with this id, or the first usable one when no id is given; null when there is none. */
  resolve(connectionId?: string | null): EmbeddingConnection | null;
  list(): EmbeddingConnection[];
  embed(connection: EmbeddingConnection, request: { inputs: string[]; signal: AbortSignal }): Promise<number[][]>;
};
