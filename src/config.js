export const eventConfig = {
  eventName: "90's Connection - Millenials Event",
  description:
    "90's Connection - Millenials Event ",
  date: "31/12/2027",
  time: "11:00 PM",
  venue: "nairobi, kenya",
  ticketPriceKes: 2500,
  businessShortcode: "ADD DARAJA PAYBILL OR TILL NUMBER",
  businessType: "BUY_GOODS",
  businessName: "Yohan Events",
};

export const bookingEndpoint = import.meta.env.VITE_BOOKING_ENDPOINT ?? "";

export const isEventConfigured =
  Boolean(eventConfig.eventName.trim()) &&
  Boolean(eventConfig.date.trim()) &&
  Boolean(eventConfig.time.trim()) &&
  Boolean(eventConfig.venue.trim()) &&
  Number.isInteger(eventConfig.ticketPriceKes) &&
  eventConfig.ticketPriceKes > 0 &&
  /^\d{5,7}$/.test(eventConfig.businessShortcode) &&
  ["BUY_GOODS", "PAYBILL"].includes(eventConfig.businessType) &&
  Boolean(eventConfig.businessName.trim());
