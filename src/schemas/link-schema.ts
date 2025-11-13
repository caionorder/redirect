export const linkSchema = {
    domain: { type: 'string', required: true },
    url: { type: 'string', required: true },
    status: { type: 'boolean', required: true },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
}
