const str = { type: 'string' };
const list = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const schemas = {
  plan: object({ goal: str, learningPath: object({ currentUnderstanding: str, targetUnderstanding: str, missingLink: str, basis: str, nextMove: { type: 'string', enum: ['clarify', 'bridge', 'verify'] } }), queries: list(str), gaps: list(object({ id: str, title: str, reason: str })) }),
  grade: object({ verdict: { type: 'string', enum: ['correct', 'incorrect', 'unclear'] }, quote: str, explanation: str, helpRequested: { type: 'boolean' } }),
  coach: object({ reply: str, focusId: str, check: { anyOf: [object({ skillId: str, kind: { type: 'string', enum: ['diagnostic', 'transfer'] }, question: str, rubric: str }), { type: 'null' }] }, suggestions: list(str), sourceIds: list(str) })
};
export function validate(value, schema, path = 'response') {
  if (schema.anyOf) {
    for (const variant of schema.anyOf) { try { return validate(value, variant, path); } catch {} }
    throw new Error(`${path} 不符合允许的结构`);
  }
  if (schema.type === 'null') { if (value !== null) throw new Error(`${path} 应为空值`); return value; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 应为对象`);
    for (const key of schema.required) if (!(key in value)) throw new Error(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) throw new Error(`${path}.${key} 为未知字段`);
      validate(value[key], schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 12) throw new Error(`${path} 列表无效`);
    value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  } else if (typeof value !== schema.type || (typeof value === 'string' && value.length > 12000)) throw new Error(`${path} 类型或长度无效`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} 值无效`);
  return value;
}
