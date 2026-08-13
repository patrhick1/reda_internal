import { supabase } from '@/lib/supabase';
import { queryClient } from '@/lib/query';
import { errorMessage } from '@/lib/errors';
import type { Database } from '@/types/database.gen';

/** Product mutation → refresh cached useProducts()/useActiveProductsByClient()
 *  consumers (Phase 2). */
function invalidateProducts(): void {
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: ['products-by-client'] });
}

export type Product = Database['public']['Tables']['product_catalog']['Row'];

export type ProductWithClient = Product & { client_name: string };

export type ProductInput = {
  productName: string;
  description: string | null;
};

/** Active products for a specific client, ordered by name. Used by the delivery-creation form. */
export async function listActiveProductsByClient(clientId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('product_catalog')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('product_name');
  if (error) throw error;
  return data ?? [];
}

/** List products joined with client name. Excludes inactive by default. */
export async function listProducts(
  opts: { includeInactive?: boolean } = {},
): Promise<ProductWithClient[]> {
  let query = supabase
    .from('product_catalog')
    .select('*, clients!inner(name)')
    .order('product_name');
  if (!opts.includeInactive) {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => {
    // supabase-js returns the joined relation under the table key
    const joined = row as Product & { clients: { name: string } };
    return { ...joined, client_name: joined.clients.name };
  });
}

export async function getProduct(id: string): Promise<ProductWithClient | null> {
  const { data, error } = await supabase
    .from('product_catalog')
    .select('*, clients!inner(name)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const joined = data as Product & { clients: { name: string } };
  return { ...joined, client_name: joined.clients.name };
}

export async function createProduct(clientId: string, input: ProductInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_product', {
    p_client_id: clientId,
    p_product_name: input.productName,
    p_description: input.description as unknown as string,
  });
  if (error) throw error;
  invalidateProducts();
  return data as string;
}

/** Per-row outcome of a bulk create. `skipped` = the client already has a
 *  product by that name (the UNIQUE (client_id, product_name) constraint),
 *  which is a no-op worth naming rather than an error worth alarming about. */
export type BulkCreateProductsResult = {
  created: number;
  skipped: string[];
  failed: number;
  firstError: string | null;
};

/** Postgres unique_violation — the shape a duplicate product name comes back
 *  as. Checked structurally because the message text is not a contract. */
function isDuplicateNameError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** Create several products for ONE client — the vendor-onboarding case.
 *
 *  `create_product` is a per-row endpoint with no idempotency key, so this
 *  loops it the way the bulk stock screens loop theirs. It doesn't need a key:
 *  UNIQUE (client_id, product_name) already makes a re-run a no-op, and that
 *  same constraint is why a duplicate is reported as `skipped` rather than
 *  failed — re-submitting after a partial batch should be safe and boring.
 *
 *  Sequential on purpose: the rows are typed by hand (a dozen at most) and
 *  ordered output makes a partial result easy to read against the form.
 *  Invalidates once at the end rather than per row. */
export async function createProducts(
  clientId: string,
  items: ProductInput[],
): Promise<BulkCreateProductsResult> {
  const result: BulkCreateProductsResult = {
    created: 0,
    skipped: [],
    failed: 0,
    firstError: null,
  };
  for (const item of items) {
    try {
      const { error } = await supabase.rpc('create_product', {
        p_client_id: clientId,
        p_product_name: item.productName,
        p_description: item.description as unknown as string,
      });
      if (error) throw error;
      result.created += 1;
    } catch (e) {
      if (isDuplicateNameError(e)) {
        result.skipped.push(item.productName);
        continue;
      }
      result.failed += 1;
      // errorMessage, not `e.message` — a PostgrestError is a plain object, so
      // the usual instanceof/String fallback yields "[object Object]".
      if (!result.firstError) result.firstError = errorMessage(e);
    }
  }
  if (result.created > 0) invalidateProducts();
  return result;
}

export async function updateProduct(
  id: string,
  input: ProductInput,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('update_product', {
    p_id: id,
    p_product_name: input.productName,
    p_description: input.description as unknown as string,
    p_reason: reason as unknown as string,
  });
  if (error) throw error;
  invalidateProducts();
}

/** What stands in the way of retiring a product, as the server sees it.
 *
 *  Agent-held units and open deliveries block; warehouse-held units are
 *  reported but never block — a retired product sitting in the warehouse just
 *  means the vendor hasn't collected their goods yet.
 *
 *  The same shape arrives two ways: from `getProductDeactivationBlockers` for
 *  the preflight, and from the refusal error's `hint` when someone issues stock
 *  between the panel rendering and the admin confirming. */
export type ProductBlockers = {
  code: 'product_deactivation_blocked';
  product_id: string;
  agent_stock: { holder_id: string; holder_name: string; quantity: number }[];
  agent_units: number;
  warehouse_units: number;
  open_deliveries: number;
  open_statuses: string[];
};

export async function getProductDeactivationBlockers(id: string): Promise<ProductBlockers> {
  const { data, error } = await supabase.rpc('product_deactivation_blockers', { p_id: id });
  if (error) throw error;
  return data as unknown as ProductBlockers;
}

/** `force` acknowledges the blockers and retires the product anyway. The server
 *  records the blocker snapshot on the audit row when it does. */
export async function deactivateProduct(id: string, reason: string, force = false): Promise<void> {
  const { error } = await supabase.rpc('deactivate_product', {
    p_id: id,
    p_reason: reason,
    p_force: force,
  });
  if (error) throw error;
  invalidateProducts();
}

export async function reactivateProduct(id: string): Promise<void> {
  const { error } = await supabase.rpc('reactivate_product', { p_id: id });
  if (error) throw error;
  invalidateProducts();
}
