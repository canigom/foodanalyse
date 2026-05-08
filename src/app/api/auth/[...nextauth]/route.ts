// NextAuth v5 packages its HTTP handlers as a single `handlers` object.
// Destructure into named GET/POST so this file matches the App Router's
// route handler convention.

import { handlers } from "@/auth";

export const { GET, POST } = handlers;
