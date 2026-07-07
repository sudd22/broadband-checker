import axios from 'axios';
import { normalizePostcode } from './postcode';
import type { PostcodesIoAutocomplete, PostcodesIoLookup } from '../types';

const BASE_URL = 'https://api.postcodes.io/postcodes';


export async function autocompletePostcode(
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const q = normalizePostcode(query);
  if (q.length < 2) return [];

  const { data } = await axios.get<PostcodesIoAutocomplete>(
    `${BASE_URL}/${encodeURIComponent(q)}/autocomplete`,
    { signal, timeout: 8000 },
  );
  return data.result ?? [];
}

export interface ValidatedPostcode {
  postcode: string; 
  country: string;
  region: string | null;
  district: string | null;
  latitude: number;
  longitude: number;
  
  place: string | null;
}


export async function lookupPostcode(
  postcode: string,
  signal?: AbortSignal,
): Promise<ValidatedPostcode | null> {
  const pc = normalizePostcode(postcode);

  try {
    const { data } = await axios.get<PostcodesIoLookup>(
      `${BASE_URL}/${encodeURIComponent(pc)}`,
      { signal, timeout: 8000 },
    );
    if (data.status !== 200 || !data.result) return null;
    const r = data.result;
    return {
      postcode: r.postcode,
      country: r.country,
      region: r.region,
      district: r.admin_district,
      latitude: r.latitude,
      longitude: r.longitude,
      place: r.parish ?? r.admin_ward ?? r.admin_district,
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null; 
    }
    throw err;
  }
}
