import { z } from 'zod';

// Roles from spec section 8.1. A person can wear several (a "hat" is a role held by a person).
export const roleSchema = z.enum([
  'product_owner',
  'architect',
  'frontend_engineer',
  'backend_engineer',
  'qa',
  'devops_release',
  'security',
  'platform_admin',
]);
export type Role = z.infer<typeof roleSchema>;
