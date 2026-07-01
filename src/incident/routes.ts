import type { IncidentType, Severity } from './schemas.js';

export const REQUIRED_FIELDS_BY_TYPE: Record<IncidentType, string[]> = {
  fall: [
    'bodyPartAffected',
    'fallLocation',
    'supervisingNurse',
    'physicianNotified',
    'injuryLevel',
  ],
  medication_error: [
    'medicationName',
    'dosageGiven',
    'dosagePrescribed',
    'pharmacistNotified',
    'residentCondition',
  ],
  elopement: [
    'durationMissing',
    'foundLocation',
    'policeNotified',
    'familyNotified',
    'preventionMeasures',
  ],
  abuse_allegation: [
    'allegationType',
    'accusedParty',
    'witnessStatements',
    'administrationNotified',
    'ombudsmanNotified',
  ],
  medical_emergency: [
    'vitalSigns',
    'emergencyServicesContacted',
    'hospitalTransfer',
    'physicianNotified',
    'familyNotified',
  ],
  property_damage: ['damageExtent', 'estimatedCost', 'responsibleParty', 'insuranceNotified'],
  physical_altercation: [
    'partiesInvolved',
    'injuriesSustained',
    'witnessStatements',
    'policeNotified',
    'counselingArranged',
  ],
  other: ['description', 'supervisorNotified', 'resolutionPlan'],
};

export const REGULATORY_PATH_BY_TYPE: Record<IncidentType, string> = {
  fall: 'state_health_dept_24h',
  medication_error: 'state_health_dept_72h',
  elopement: 'state_health_dept_immediate_plus_police',
  abuse_allegation: 'state_ombudsman_immediate_plus_administration',
  medical_emergency: 'facility_internal_review_24h',
  property_damage: 'facility_internal_review_30d',
  physical_altercation: 'state_health_dept_48h_plus_police',
  other: 'facility_internal_review_72h',
};

export const DEFAULT_NOTIFICATIONS_BY_TYPE: Record<IncidentType, string[]> = {
  fall: [
    'Charge Nurse',
    'Attending Physician',
    'Family/Responsible Party',
    'Facility Quality Officer',
  ],
  medication_error: [
    'Charge Nurse',
    'Attending Physician',
    'Pharmacist',
    'Family/Responsible Party',
    'Facility Quality Officer',
  ],
  elopement: [
    'Facility Administrator',
    'Local Law Enforcement',
    'Family/Responsible Party',
    'State Health Department (24h report)',
  ],
  abuse_allegation: [
    'Facility Administrator',
    'State Long-Term Care Ombudsman',
    'Law Enforcement (if alleged crime)',
    'APS (Adult Protective Services)',
  ],
  medical_emergency: [
    'EMS (already on scene)',
    'Attending Physician',
    'Receiving Hospital',
    'Family/Responsible Party',
  ],
  property_damage: ['Facility Maintenance', 'Facility Administrator'],
  physical_altercation: [
    'Facility Administrator',
    'Local Law Enforcement',
    'Family/Responsible Party (both parties)',
    'Facility Quality Officer',
  ],
  other: ['Facility Administrator', 'Facility Quality Officer'],
};

export const ESCALATION_REASON_BY_SEVERITY: Record<Severity, string> = {
  low: 'Manual review recommended',
  medium: 'Manual review recommended due to medium severity',
  high: 'Immediate human review required due to high severity',
  critical: 'Immediate human review required due to critical severity',
};
