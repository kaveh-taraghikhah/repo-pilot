export interface ArchitectureRule {
  name: string;
  from: string;
  cannotImport: string[];
}

export interface RuleViolation {
  rule: string;
  from: string;
  to: string;
}
