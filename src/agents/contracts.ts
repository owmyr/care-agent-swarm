import { z } from 'zod';

export const ResidentIntakeFormSchema = z.object({
  residentId: z.string().min(1),
  residentName: z.string().min(1),
  dateOfBirth: z.string().min(1),
  admissionDate: z.string().min(1),
  state: z.string().length(2),
  careLevel: z.enum(['independent', 'assisted', 'memory_care', 'skilled_nursing']),
  rawClinicalNotes: z.string().min(1),
  carePlan: z.object({
    dailyActivities: z.array(z.string()),
    medicalSupervision: z.string(),
    emergencyProtocol: z.string(),
    nutritionPlan: z.string(),
    mobilityAssistance: z.string(),
  }),
  familyContact: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
  facilityName: z.string(),
  assignedNurse: z.string(),
  visitingHours: z.string(),
});
export type ResidentIntakeForm = z.infer<typeof ResidentIntakeFormSchema>;

export const MedicalInputSchema = z.object({
  residentName: z.string(),
  dateOfBirth: z.string(),
  admissionDate: z.string(),
  rawClinicalNotes: z.string(),
});
export type MedicalInput = z.infer<typeof MedicalInputSchema>;

export const MedicalOutputSchema = z.object({
  summary: z.string().max(2000),
  conditions: z.array(z.string()),
  medications: z.array(z.string()),
  allergies: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high']),
  flaggedConcerns: z.array(z.string()),
});
export type MedicalOutput = z.infer<typeof MedicalOutputSchema>;

export const ComplianceInputSchema = z.object({
  residentName: z.string(),
  careLevel: ResidentIntakeFormSchema.shape.careLevel,
  carePlan: ResidentIntakeFormSchema.shape.carePlan,
  state: z.string().length(2),
});
export type ComplianceInput = z.infer<typeof ComplianceInputSchema>;

export const ComplianceViolationSchema = z.object({
  requirement: z.string(),
  finding: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
});
export type ComplianceViolation = z.infer<typeof ComplianceViolationSchema>;

export const ComplianceOutputSchema = z.object({
  compliant: z.boolean(),
  score: z.number().min(0).max(100),
  violations: z.array(ComplianceViolationSchema),
  recommendations: z.array(z.string()),
  requiresImmediateAction: z.boolean(),
});
export type ComplianceOutput = z.infer<typeof ComplianceOutputSchema>;

export const FamilyInputSchema = z.object({
  residentName: z.string(),
  familyContactName: z.string(),
  facilityName: z.string(),
  admissionDate: z.string(),
  careLevel: z.string(),
  assignedNurse: z.string(),
  visitingHours: z.string(),
  emergencyContact: z.string(),
});
export type FamilyInput = z.infer<typeof FamilyInputSchema>;

export const FamilyOutputSchema = z.object({
  subject: z.string(),
  greeting: z.string(),
  body: z.string().max(2000),
  keyPoints: z.array(z.string()),
  signature: z.string(),
  tone: z.enum(['formal', 'warm', 'informational']),
});
export type FamilyOutput = z.infer<typeof FamilyOutputSchema>;

export const SubAgentResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  status: z.enum(['ok', 'degraded', 'failed']),
  attempts: z.number().int().min(0),
  durationMs: z.number().min(0),
  traceId: z.string().optional(),
});
export type SubAgentResult = z.infer<typeof SubAgentResultSchema>;

export const IntakeOrchestrationResultSchema = z.object({
  intakeId: z.string(),
  residentId: z.string(),
  status: z.enum(['complete', 'partial', 'failed']),
  completedAt: z.string(),
  results: z.object({
    medicalHistory: SubAgentResultSchema,
    compliance: SubAgentResultSchema,
    familyCommunication: SubAgentResultSchema,
  }),
  summary: z.string(),
  flaggedIssues: z.array(z.string()),
  incomplete: z.array(z.string()),
  nextSteps: z.array(z.string()),
  totalDurationMs: z.number().min(0),
  traceId: z.string(),
});
export type IntakeOrchestrationResult = z.infer<typeof IntakeOrchestrationResultSchema>;
