export type ContextType = 'media' | 'supports' | 'container' | 'layer' | 'other';

export interface RuleContext {
  type: ContextType;
  header: string;
}

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
  sourceOrder: number;
}

export interface ElementNode {
  id: string;
  parentId: string | null;
  tagName: string;
  classes: string[];
  attributes: Record<string, string>;
}

export interface SourceRule {
  nodeId: string;
  originalSelector: string;
  suffix: string;
  specificity: number;
  contexts: RuleContext[];
  declarations: Declaration[];
  sourceOrder: number;
}

export interface PageSnapshot {
  nodes: ElementNode[];
  rules: SourceRule[];
  warnings: string[];
  selectedLabel: string;
  originalHtml: string;
}

export interface AnalyzeOptions {
  mode: 'selected' | 'manual';
  includeDescendants: boolean;
  manualClasses: string[];
}

export interface OutputNode extends ElementNode {
  outputSelector: string;
  outputClass: string | null;
}

export interface GeneratedOutput {
  css: string;
  html: string;
  warnings: string[];
  nodes: OutputNode[];
}
