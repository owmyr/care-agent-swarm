import { z } from 'zod';

export const IncidentTypeSchema = z.enum([
  'fall',
  'medication_error',
  'elopement',
  'abuse_allegation',
  'medical_emergency',
  'property_damage',
  'physical_altercation',
  'other',
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const IncidentReportSchema = z.object({
  incidentId: z.string().min(1),
  reportedBy: z.string().min(1),
  reportedAt: z.string().min(1),
  residentId: z.string().min(1),
  residentName: z.string().min(1),
  location: z.string().min(1),
  description: z.string().min(1),
  witnesses: z.array(z.string()).default([]),
  immediateActionsTaken: z.string().min(1),
  // optional fields that the LLM can fill in
  bodyPartAffected: z.string().optional(),
  fallLocation: z.string().optional(),
  supervisingNurse: z.string().optional(),
  physicianNotified: z.string().optional(),
  injuryLevel: z.string().optional(),
  medicationName: z.string().optional(),
  dosageGiven: z.string().optional(),
  dosagePrescribed: z.string().optional(),
  pharmacistNotified: z.string().optional(),
  residentCondition: z.string().optional(),
  durationMissing: z.string().optional(),
  foundLocation: z.string().optional(),
  policeNotified: z.string().optional(),
  familyNotified: z.string().optional(),
  preventionMeasures: z.string().optional(),
  allegationType: z.string().optional(),
  accusedParty: z.string().optional(),
  witnessStatements: z.string().optional(),
  administrationNotified: z.string().optional(),
  ombudsmanNotified: z.string().optional(),
  vitalSigns: z.string().optional(),
  emergencyServicesContacted: z.string().optional(),
  hospitalTransfer: z.string().optional(),
  damageExtent: z.string().optional(),
  estimatedCost: z.string().optional(),
  responsibleParty: z.string().optional(),
  insuranceNotified: z.string().optional(),
  partiesInvolved: z.string().optional(),
  injuriesSustained: z.string().optional(),
  counselingArranged: z.string().optional(),
  supervisorNotified: z.string().optional(),
  resolutionPlan: z.string().optional(),
});
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

export const ClassificationOutputSchema = z.object({
  type: IncidentTypeSchema,
  severity: SeveritySchema,
  reasoning: z.string(),
  regulatoryPath: z.string(),
  requiredNotifications: z.array(z.string()),
});
export type ClassificationOutput = z.infer<typeof ClassificationOutputSchema>;

export const InferFieldsOutputSchema = z.object({
  fields: z.record(z.string(), z.string()),
  reasoning: z.string(),
});
export type InferFieldsOutput = z.infer<typeof InferFieldsOutputSchema>;

export const ValidationHistoryEntrySchema = z.object({
  iteration: z.number().int().min(0),
  missingFields: z.array(z.string()),
  fieldsAdded: z.array(z.string()),
  validationPassed: z.boolean(),
  durationMs: z.number().min(0),
  inferError: z.string().optional(),
});
export type ValidationHistoryEntry = z.infer<typeof ValidationHistoryEntrySchema>;

export const IncidentWorkflowErrorSchema = z.object({
  phase: z.enum(['classify', 'infer', 'validate', 'route']),
  message: z.string(),
  kind: z.string().optional(),
});
export type IncidentWorkflowError = z.infer<typeof IncidentWorkflowErrorSchema>;

export const IncidentAuditTrailSchema = z.object({
  incidentId: z.string(),
  traceId: z.string(),
  processedAt: z.string(),
  incidentType: IncidentTypeSchema,
  severity: SeveritySchema,
  regulatoryPath: z.string(),
  iterations: z.number().int().min(0),
  loopGuardTriggered: z.boolean(),
  humanEscalationRequired: z.boolean(),
  escalationReason: z.string().optional(),
  validationHistory: z.array(ValidationHistoryEntrySchema),
  finalReport: z.record(z.string(), z.unknown()),
  notificationsSent: z.array(z.string()),
  errors: z.array(IncidentWorkflowErrorSchema),
});
export type IncidentAuditTrail = z.infer<typeof IncidentAuditTrailSchema>;
