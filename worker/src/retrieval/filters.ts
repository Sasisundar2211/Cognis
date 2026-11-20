/** Metadata filters shared by lexical, semantic and list queries. All values are bound, never interpolated. */
export type ItemFilters = {
  source?: string;
  tag?: string;
  collectionId?: string;
  from?: string;
  to?: string;
  includeArchived?: boolean;
  status?: string;
};

export function buildFilterSql(alias: string, f: ItemFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!f.includeArchived) clauses.push(`${alias}.archived = 0`);
  if (f.source) {
    clauses.push(`${alias}.source_platform = ?`);
    params.push(f.source);
  }
  if (f.status) {
    clauses.push(`${alias}.status = ?`);
    params.push(f.status);
  }
  if (f.from) {
    clauses.push(`${alias}.created_at >= ?`);
    params.push(f.from);
  }
  if (f.to) {
    clauses.push(`${alias}.created_at <= ?`);
    params.push(f.to);
  }
  if (f.tag) {
    clauses.push(
      `EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ${alias}.id AND it.user_id = ${alias}.user_id AND t.name = ?)`,
    );
    params.push(f.tag);
  }
  if (f.collectionId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_id = ${alias}.id AND ci.user_id = ${alias}.user_id AND ci.collection_id = ?)`,
    );
    params.push(f.collectionId);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}
