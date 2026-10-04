// The JOB_HOPPER_SECRET_KEY every test app runs with (design.md "Secrets at rest"): 32 fixed bytes,
// base64. A throwaway: it seals nothing outside a test database.
export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
