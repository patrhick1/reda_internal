import { supabase } from '@/lib/supabase';
import { queryClient } from '@/lib/query';
import type { Database } from '@/types/database.gen';

/** Location mutation → refresh cached useLocations() consumers (Phase 2). */
function invalidateLocations(): void {
  void queryClient.invalidateQueries({ queryKey: ['locations'] });
}

export type Location = Database['public']['Tables']['locations']['Row'];

export type LocationInput = {
  name: string;
  aliases: string[];
  latitude: number | null;
  longitude: number | null;
};

export async function listLocations(opts: { includeInactive?: boolean } = {}): Promise<Location[]> {
  let query = supabase.from('locations').select('*').order('name');
  if (!opts.includeInactive) {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getLocation(id: string): Promise<Location | null> {
  const { data, error } = await supabase.from('locations').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function createLocation(input: LocationInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_location', {
    p_name: input.name,
    p_aliases: input.aliases,
    p_latitude: input.latitude as unknown as number,
    p_longitude: input.longitude as unknown as number,
  });
  if (error) throw error;
  invalidateLocations();
  return data as string;
}

export async function updateLocation(
  id: string,
  input: LocationInput,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('update_location', {
    p_id: id,
    p_name: input.name,
    p_aliases: input.aliases,
    p_latitude: input.latitude as unknown as number,
    p_longitude: input.longitude as unknown as number,
    p_reason: reason as unknown as string,
  });
  if (error) throw error;
  invalidateLocations();
}

export async function deactivateLocation(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('deactivate_location', { p_id: id, p_reason: reason });
  if (error) throw error;
  invalidateLocations();
}

export async function reactivateLocation(id: string): Promise<void> {
  const { error } = await supabase.rpc('reactivate_location', { p_id: id });
  if (error) throw error;
  invalidateLocations();
}
