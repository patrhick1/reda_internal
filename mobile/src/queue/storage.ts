// AsyncStorage-backed persistence for the mutation queue.
//
// Single key (`reda:queue:v1`) holds the whole job list as JSON. Volume stays
// small (worst-case ~hundreds of pending mutations), so a single read/write
// per change is fine and avoids the complexity of an indexed store.
//
// Versioned key means we can ship a v2 schema later and migrate cleanly.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Job } from './types';

const KEY = 'reda:queue:v1';

export async function loadJobs(): Promise<Job[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Job[];
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(jobs));
}

export async function clearJobs(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
