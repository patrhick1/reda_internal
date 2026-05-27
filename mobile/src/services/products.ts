import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';

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
  return data as string;
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
}

export async function deactivateProduct(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('deactivate_product', { p_id: id, p_reason: reason });
  if (error) throw error;
}

export async function reactivateProduct(id: string): Promise<void> {
  const { error } = await supabase.rpc('reactivate_product', { p_id: id });
  if (error) throw error;
}
