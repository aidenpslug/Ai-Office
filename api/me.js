// GET /api/me: the signed-in person's access and tickets left this month.
import { userFromRequest, ticketsUsed, errorResponse, json } from './_lib.js';

export async function GET(request) {
  try {
    const user = await userFromRequest(request);
    const used = (await ticketsUsed([user.id]))[user.id] || 0;
    const m = user.member;
    return json({ email: user.email, role: m.role, monthlyTickets: m.role === 'owner' ? null : m.monthly_tickets, used });
  } catch (err) { return errorResponse(err); }
}
