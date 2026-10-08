import ts from "typescript";

/** Files at or above this cyclomatic-ish score are flagged. */
export const COMPLEXITY_THRESHOLD = 20;

const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,
]);

export function fileComplexity(sourceFile: ts.SourceFile): number {
  let score = 1;

  const visit = (node: ts.Node): void => {
    if (BRANCH_KINDS.has(node.kind)) {
      if (ts.isBinaryExpression(node)) {
        if (
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          score += 1;
        }
      } else {
        score += 1;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return score;
}

export function isHighComplexity(score: number, threshold = COMPLEXITY_THRESHOLD): boolean {
  return score >= threshold;
}
