// Minimal JSON Schema validator for the subset the project and command schemas
// use. The schemas themselves are plain JSON Schema (draft 2020-12 keywords),
// so they can be handed unchanged to tools that expect JSON Schema.
//
// Supported: type (string or list), enum, const, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern, items,
// minItems, maxItems, properties, required, additionalProperties (boolean or
// schema), oneOf, $ref to "#/$defs/<name>".

/**
 * @returns {{ path: string, message: string }[]} empty when valid
 */
export function validate(schema, value, root = schema) {
    const errors = [];
    check(schema, value, '', root, errors);
    return errors;
}

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function typeMatches(want, v) {
    const t = typeOf(v);
    if (want === t) return true;
    if (want === 'number' && t === 'integer') return true;
    return false;
}

function resolve(schema, root) {
    if (!schema.$ref) return schema;
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && root.$defs?.[m[1]];
    if (!target) throw new Error(`Unresolvable $ref ${schema.$ref}`);
    return target;
}

function check(schemaIn, v, path, root, errors) {
    const s = resolve(schemaIn, root);
    const at = path || '/';
    if (s.type !== undefined) {
        const types = Array.isArray(s.type) ? s.type : [s.type];
        if (!types.some((t) => typeMatches(t, v))) {
            errors.push({ path: at, message: `must be ${types.join(' or ')}` });
            return;
        }
    }
    if (typeof v === 'number' && !Number.isFinite(v)) {
        errors.push({ path: at, message: 'must be a finite number' });
        return;
    }
    if (s.const !== undefined && v !== s.const) errors.push({ path: at, message: `must be ${JSON.stringify(s.const)}` });
    if (s.enum && !s.enum.includes(v)) errors.push({ path: at, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });

    if (typeof v === 'number') {
        if (s.minimum !== undefined && v < s.minimum) errors.push({ path: at, message: `must be ≥ ${s.minimum}` });
        if (s.maximum !== undefined && v > s.maximum) errors.push({ path: at, message: `must be ≤ ${s.maximum}` });
        if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push({ path: at, message: `must be > ${s.exclusiveMinimum}` });
        if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) errors.push({ path: at, message: `must be < ${s.exclusiveMaximum}` });
    }
    if (typeof v === 'string') {
        if (s.minLength !== undefined && v.length < s.minLength) errors.push({ path: at, message: `must have at least ${s.minLength} characters` });
        if (s.maxLength !== undefined && v.length > s.maxLength) errors.push({ path: at, message: `must have at most ${s.maxLength} characters` });
        if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) errors.push({ path: at, message: `must match ${s.pattern}` });
    }
    if (Array.isArray(v)) {
        if (s.minItems !== undefined && v.length < s.minItems) errors.push({ path: at, message: `must have at least ${s.minItems} items` });
        if (s.maxItems !== undefined && v.length > s.maxItems) errors.push({ path: at, message: `must have at most ${s.maxItems} items` });
        if (s.items) v.forEach((item, i) => check(s.items, item, `${path}/${i}`, root, errors));
    }
    if (typeOf(v) === 'object') {
        for (const k of s.required ?? []) {
            if (!(k in v)) errors.push({ path: `${path}/${k}`, message: 'is required' });
        }
        const props = s.properties ?? {};
        for (const [k, val] of Object.entries(v)) {
            if (props[k]) check(props[k], val, `${path}/${k}`, root, errors);
            else if (s.additionalProperties === false) errors.push({ path: `${path}/${k}`, message: 'is not allowed' });
            else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${path}/${k}`, root, errors);
        }
    }
    if (s.oneOf) checkOneOf(s.oneOf, v, path, root, errors);
}

function checkOneOf(branches, v, path, root, errors) {
    // Discriminated unions: when branches pin a property with `const`, pick the
    // branch by that value so errors are about the intended shape.
    const resolved = branches.map((b) => resolve(b, root));
    const disc = discriminator(resolved);
    if (disc && typeOf(v) === 'object') {
        const branch = resolved.find((b) => b.properties[disc].const === v[disc]);
        if (!branch) {
            const allowed = resolved.map((b) => JSON.stringify(b.properties[disc].const)).join(', ');
            errors.push({ path: `${path}/${disc}`, message: `must be one of ${allowed}` });
            return;
        }
        check(branch, v, path, root, errors);
        return;
    }
    const results = resolved.map((b) => validate(b, v, root));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing === 1) return;
    if (passing > 1) {
        errors.push({ path: path || '/', message: 'matches more than one allowed form' });
        return;
    }
    // Report the closest branch (fewest errors).
    const best = results.reduce((a, b) => (b.length < a.length ? b : a));
    errors.push(...best);
}

function discriminator(branches) {
    if (!branches.length || !branches.every((b) => b.properties)) return null;
    for (const key of Object.keys(branches[0].properties)) {
        if (branches.every((b) => b.properties[key]?.const !== undefined && (b.required ?? []).includes(key))) return key;
    }
    return null;
}
