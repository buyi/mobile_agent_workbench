import ts from "typescript"

/** The M0 fixture accepts one small pure function, not arbitrary modules. Parsing
 * and transpiling treat the candidate as data; neither executes it in the signer.
 * The restricted grammar also prevents a candidate from replacing the child's
 * transport, VM intrinsics, test driver or process globals to forge observations. */
export function compilePureFixture(source: string): string {
  if (Buffer.byteLength(source) > 64 * 1024) throw new Error("candidate_too_large")
  const file = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length || file.statements.length !== 1) throw new Error("unsupported_candidate_syntax")
  const fn = file.statements[0]
  if (!ts.isFunctionDeclaration(fn) || fn.name?.text !== "sumEvenThrough" || !fn.body || fn.asteriskToken ||
      fn.typeParameters?.length || fn.parameters.length !== 1 || fn.modifiers?.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword))
    throw new Error("unsupported_candidate_entry")
  const param = fn.parameters[0]
  if (!ts.isIdentifier(param.name) || param.name.text !== "n" || param.initializer || param.dotDotDotToken || param.questionToken ||
      (param.type && param.type.kind !== ts.SyntaxKind.NumberKeyword) || (fn.type && fn.type.kind !== ts.SyntaxKind.NumberKeyword))
    throw new Error("unsupported_candidate_signature")

  const names = new Set(["n"])
  const gather = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name) || ["Number", "RangeError", "sumEvenThrough"].includes(node.name.text) || node.name.text.startsWith("__"))
        throw new Error("unsupported_candidate_binding")
      names.add(node.name.text)
    }
    ts.forEachChild(node, gather)
  }
  gather(fn.body)
  const binary = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken])
  const expression = (node: ts.Expression): void => {
    if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return
    if (ts.isIdentifier(node)) { if (!names.has(node.text)) throw new Error("unsupported_candidate_global"); return }
    if (ts.isParenthesizedExpression(node)) { expression(node.expression); return }
    if (ts.isBinaryExpression(node) && binary.has(node.operatorToken.kind)) {
      if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(node.operatorToken.kind) && !ts.isIdentifier(node.left))
        throw new Error("unsupported_candidate_assignment")
      expression(node.left); expression(node.right); return
    }
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) { expression(node.operand); return }
    if (ts.isPostfixUnaryExpression(node)) { expression(node.operand); return }
    if (ts.isConditionalExpression(node)) { expression(node.condition); expression(node.whenTrue); expression(node.whenFalse); return }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Number" &&
        node.expression.name.text === "isInteger" && node.arguments.length === 1 && !node.typeArguments?.length) {
      expression(node.arguments[0]); return
    }
    throw new Error("unsupported_candidate_expression")
  }
  const variables = (node: ts.VariableDeclarationList) => {
    for (const declaration of node.declarations) {
      if (declaration.type && declaration.type.kind !== ts.SyntaxKind.NumberKeyword) throw new Error("unsupported_candidate_type")
      if (declaration.initializer) expression(declaration.initializer)
    }
  }
  const statement = (node: ts.Statement): void => {
    if (ts.isBlock(node)) { node.statements.forEach(statement); return }
    if (ts.isVariableStatement(node)) { variables(node.declarationList); return }
    if (ts.isExpressionStatement(node)) { expression(node.expression); return }
    if (ts.isReturnStatement(node) && node.expression) { expression(node.expression); return }
    if (ts.isIfStatement(node)) { expression(node.expression); statement(node.thenStatement); if (node.elseStatement) statement(node.elseStatement); return }
    if (ts.isForStatement(node)) {
      if (node.initializer) ts.isVariableDeclarationList(node.initializer) ? variables(node.initializer) : expression(node.initializer)
      if (node.condition) expression(node.condition)
      if (node.incrementor) expression(node.incrementor)
      statement(node.statement); return
    }
    if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "RangeError" && !node.expression.typeArguments?.length &&
        (node.expression.arguments?.length ?? 0) <= 1 && node.expression.arguments?.every(ts.isStringLiteral)) return
    throw new Error("unsupported_candidate_statement")
  }
  statement(fn.body)
  // Remove the sole export modifier after AST validation. The transpiler cannot
  // load imports/plugins; the restricted input contains no module dependencies.
  const modifier = fn.modifiers?.[0]
  const plain = modifier ? source.slice(0, modifier.getStart(file)) + source.slice(modifier.end) : source
  const output = ts.transpileModule(plain, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true })
  if (output.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error("candidate_transpile_failed")
  return output.outputText
}
