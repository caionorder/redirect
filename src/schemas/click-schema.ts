export const clickSchema = {
    link_id: { type: 'string', required: true },
    count: { type: 'number',  default: 1 },
    created_at: { type: Date, default: Date.now }
}
