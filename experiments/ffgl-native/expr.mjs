/** Lowers a Loom expression to the stack program the native engine runs every frame.
 *  The profile is arithmetic over exported controls: numbers, + - * /, unary sign, parentheses and
 *  `op('<control>').chan.<channel>`. Everything else is refused, naming what was met. */
import {parseExpression} from '../../src/domain/expressions/index.ts';
/** `controlIndex(nodeName, channel)` returns the control's index, or a string saying why it has none. */
export function lowerExpression(source,controlIndex){
 const parsed=parseExpression(source);
 if(!parsed.ok)throw Error(`cannot parse (${parsed.reason})`);
 const program=[],reads=new Set();
 const visit=(ast)=>{
  if(ast.kind==='number'){program.push(ast.value);return;}
  if(ast.kind==='unary'){visit(ast.operand);if(ast.operator==='-')program.push('neg');return;}
  if(ast.kind==='binary'){
   if(!['+','-','*','/'].includes(ast.operator))throw Error(`operator "${ast.operator}" is outside the export profile (arithmetic is + - * /)`);
   visit(ast.left);visit(ast.right);program.push(ast.operator);return;
  }
  if(ast.kind==='opRef'){
   if(ast.path.length!==2||ast.path[0]!=='chan')throw Error(`op('${ast.name}').${ast.path.join('.')} is not a channel read`);
   const index=controlIndex(ast.name,ast.path[1]);
   if(typeof index!=='number')throw Error(`op('${ast.name}').chan.${ast.path[1]}: ${index}`);
   reads.add(index);program.push(`c${index}`);return;
  }
  if(ast.kind==='variable')throw Error(`reads "${ast.name}", which is not an exported control`);
  if(ast.kind==='call')throw Error(`calls ${ast.name}(), which is outside the export profile`);
  throw Error(`uses a ${ast.kind}, which is outside the export profile`);
 };
 visit(parsed.ast);
 return {program,reads:[...reads].sort((a,b)=>a-b)};
}
/** The engine's evaluator, in JavaScript: doubles throughout, as Loom's own evaluator. */
export function runProgram(program,controls){
 const stack=[];
 for(const step of program){
  if(typeof step==='number')stack.push(step);
  else if(step==='neg')stack.push(-stack.pop());
  else if(step[0]==='c')stack.push(controls[Number(step.slice(1))]);
  else{const b=stack.pop(),a=stack.pop();stack.push(step==='+'?a+b:step==='-'?a-b:step==='*'?a*b:a/b);}
 }
 if(stack.length!==1)throw Error('malformed expression program');
 return stack[0];
}
