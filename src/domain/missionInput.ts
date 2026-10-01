import { createHash } from 'node:crypto';
import type { CreateMissionRequest, Priority } from '../api/types.js';

export const MISSION_TYPES = [
  'physical_verification',
  'photo',
  'phone_call',
  'data_collection',
  'document_check',
  'other',
] as const;

export type MissionType = (typeof MISSION_TYPES)[number];

const TYPE_LABELS: Record<MissionType, string> = {
  physical_verification: 'Vérification physique sur place',
  photo: 'Prise de photos',
  phone_call: 'Appel téléphonique',
  data_collection: 'Collecte d’informations',
  document_check: 'Vérification de documents',
  other: 'Autre tâche',
};

export interface MissionInput {
  type: MissionType;
  title: string;
  instructions: string;
  location?: { city?: string; address?: string; country?: string; details?: string };
  deliverables?: string[];
  budget: number;
  currency: string;
  deadline: string;
  priority: 'low' | 'medium' | 'high';
  client_reference?: string;
}

/**
 * AIWorkPay stores a mission as a title and a free-text description: the type,
 * place and expected deliverables are rendered into the description with a
 * fixed layout, so the Payworker sees exactly what the agent asked for.
 */
export function renderDescription(input: MissionInput): string {
  const sections: string[] = [`Type de mission : ${TYPE_LABELS[input.type]}`, input.instructions.trim()];

  const location = input.location;
  if (location && Object.values(location).some((value) => value?.trim())) {
    const lines = [
      location.address?.trim() && `- Adresse : ${location.address.trim()}`,
      location.city?.trim() && `- Ville : ${location.city.trim()}`,
      location.country?.trim() && `- Pays : ${location.country.trim()}`,
      location.details?.trim() && `- Précisions : ${location.details.trim()}`,
    ].filter(Boolean);
    sections.push(`Lieu :\n${lines.join('\n')}`);
  }

  const deliverables = (input.deliverables ?? []).map((d) => d.trim()).filter(Boolean);
  if (deliverables.length > 0) {
    sections.push(`Livrables attendus :\n${deliverables.map((d) => `- ${d}`).join('\n')}`);
  }

  sections.push(
    'Livraison : décrivez ce que vous avez fait et constaté, avec la date et l’heure. ' +
      'Joignez vos preuves (photos, documents) sous forme de liens https.'
  );

  return sections.join('\n\n');
}

export function toCreateRequest(input: MissionInput): CreateMissionRequest {
  return {
    title: input.title.trim(),
    description: renderDescription(input),
    budget: input.budget,
    currency: input.currency.toUpperCase(),
    deadline: input.deadline,
    priority: input.priority.toUpperCase() as Priority,
    paymentMode: 'checkout',
  };
}

/**
 * Idempotency-Key sent to AIWorkPay. With a `client_reference`, the agent's own
 * identifier decides; without one, the content of the request does, so that
 * the same mission submitted twice (retry, loop) is created only once.
 */
export function idempotencyKeyFor(input: MissionInput, request: CreateMissionRequest): string {
  const source = input.client_reference
    ? `ref:${input.client_reference}`
    : `body:${JSON.stringify(request)}`;
  return `mcp-${createHash('sha256').update(source).digest('hex').slice(0, 48)}`;
}
