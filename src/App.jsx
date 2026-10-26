import React, { useEffect, useState } from "react";
import {
  bookingEndpoint,
  eventConfig,
  isEventConfigured,
} from "./config.js";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    maximumFractionDigits: 0,
  }).format(price);

function App() {
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [stage, setStage] = useState("details");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeBooking, setActiveBooking] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("Pending Verification");
  const [statusMessage, setStatusMessage] = useState("");
  const [message, setMessage] = useState(null);

  const canBook = isEventConfigured && bookingEndpoint.trim().length > 0;

  useEffect(() => {
    if (stage !== "waiting" || !activeBooking) return undefined;

    let cancelled = false;
    let timer;
    let attempts = 0;

    async function checkStatus() {
      if (cancelled || attempts >= 30) {
        if (!cancelled && attempts >= 30) {
          setStatusMessage(
            "This is taking longer than expected. Approve the prompt if it is still on your phone; you can check this booking again shortly.",
          );
        }
        return;
      }

      attempts += 1;
      try {
        const response = await fetch(bookingEndpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "status",
            bookingId: activeBooking.bookingId,
            statusToken: activeBooking.statusToken,
          }),
        });
        const result = await response.json();
        if (!response.ok || result.success !== true) {
          throw new Error(result.message || "Unable to check payment status.");
        }

        if (result.paymentStatus === "Paid") {
          setPaymentStatus("Paid");
          setStatusMessage(
            "Payment confirmed. Your ticket booking is confirmed.",
          );
          return;
        }
        if (result.paymentStatus === "Rejected") {
          setPaymentStatus("Rejected");
          setStatusMessage(
            result.paymentResult || "The payment was not completed.",
          );
          return;
        }
      } catch {
        if (!cancelled) {
          setStatusMessage(
            "Waiting for M-Pesa confirmation. This page will keep checking.",
          );
        }
      }

      if (!cancelled) timer = window.setTimeout(checkStatus, 4000);
    }

    checkStatus();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeBooking, stage]);

  function showPaymentInstructions(event) {
    event.preventDefault();
    setMessage(null);

    if (!fullName.trim()) {
      setMessage({ type: "error", text: "Please enter your full name." });
      return;
    }
    if (!normalizePhoneNumber(phoneNumber)) {
      setMessage({
        type: "error",
        text: "Enter a valid Kenyan mobile number, such as 0712345678.",
      });
      return;
    }

    if (!canBook) {
      setMessage({
        type: "error",
        text: "Bookings are not set up yet. Please check back soon.",
      });
      return;
    }

    setStage("payment");
  }

  async function requestPayment(event) {
    event.preventDefault();
    if (isSubmitting) return;

    const name = fullName.trim();
    const phone = normalizePhoneNumber(phoneNumber);
    if (!name || !phone) {
      setMessage({
        type: "error",
        text: "Enter your full name and a valid Kenyan mobile number.",
      });
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    const bookingId = window.crypto.randomUUID();
    const statusToken = window.crypto.randomUUID() + window.crypto.randomUUID();
    try {
      const response = await fetch(bookingEndpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "initiate",
          bookingId,
          statusToken,
          fullName: name,
          phoneNumber: phone,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) {
        if (
          result.bookingId === bookingId &&
          result.statusToken === statusToken
        ) {
          setActiveBooking({ bookingId, statusToken });
          setPaymentStatus("Pending Verification");
          setStatusMessage(
            result.message ||
              "The payment request outcome is unknown. Check your phone before retrying.",
          );
          setStage("waiting");
          return;
        }
        throw new Error(result.message || "We could not submit your booking.");
      }

      setActiveBooking({
        bookingId,
        statusToken,
      });
      setPaymentStatus("Pending Verification");
      setStatusMessage(
        "A payment request has been sent. Approve it on your phone to complete payment.",
      );
      setStage("waiting");
    } catch (error) {
      if (error instanceof TypeError) {
        setActiveBooking({ bookingId, statusToken });
        setPaymentStatus("Pending Verification");
        setStatusMessage(
          "We could not confirm the response. Check your phone for a prompt; this page will check booking status. Please do not send another prompt yet.",
        );
        setStage("waiting");
      } else {
        setMessage({ type: "error", text: error.message });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function startOver() {
    setFullName("");
    setPhoneNumber("");
    setStage("details");
    setActiveBooking(null);
    setPaymentStatus("Pending Verification");
    setStatusMessage("");
    setMessage(null);
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Event home">
          <span className="brand-mark" aria-hidden="true">
            E
          </span>
          <span>EVENT PASS</span>
        </a>
        <span className="topbar-note">A moment worth showing up for</span>
      </header>

      <section className="event-layout" id="home">
        <div className="event-copy">
          <p className="eyebrow">
            <span className="eyebrow-dot" />
            ONE DAY. ONE GREAT EXPERIENCE.
          </p>
          <h1>{eventConfig.eventName}</h1>
          <p className="description">{eventConfig.description}</p>

          <div className="event-facts" aria-label="Event details">
            <div className="fact">
              <span className="fact-icon" aria-hidden="true">
                <CalendarIcon />
              </span>
              <div>
                <span className="fact-label">DATE &amp; TIME</span>
                <p>{eventConfig.date}</p>
                <p>{eventConfig.time}</p>
              </div>
            </div>
            <div className="fact">
              <span className="fact-icon" aria-hidden="true">
                <LocationIcon />
              </span>
              <div>
                <span className="fact-label">VENUE</span>
                <p>{eventConfig.venue}</p>
              </div>
            </div>
          </div>

          <div className="price-block">
            <span className="fact-label">YOUR TICKET</span>
            <p className="price">
              {eventConfig.ticketPriceKes > 0 ? (
                <>
                  {formatPrice(eventConfig.ticketPriceKes)}
                  <span> / person</span>
                </>
              ) : (
                "Set ticket price"
              )}
            </p>
          </div>
        </div>

        <section className="booking-card" aria-labelledby="booking-title">
          <div className="card-heading">
            <span className="step-label">
              {stage === "details" && "STEP 01 / 02"}
              {stage === "payment" && "STEP 02 / 02"}
              {stage === "waiting" && paymentStatus.toUpperCase()}
            </span>
            <h2 id="booking-title">
              {stage === "waiting"
                ? paymentStatus === "Paid"
                  ? "Payment confirmed."
                  : paymentStatus === "Rejected"
                    ? "Payment not completed."
                    : "Check your phone."
                : stage === "payment"
                  ? "Ready to pay?"
                  : "Save your spot."}
            </h2>
            <p>
              {stage === "details" &&
                "Enter your name and M-Pesa number to get started."}
              {stage === "payment" &&
                "We’ll send a secure M-Pesa payment prompt to your phone."}
              {stage === "waiting" && statusMessage}
            </p>
          </div>

          {message && (
            <div
              className={`message message-${message.type}`}
              role={message.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {message.text}
            </div>
          )}

          {stage === "details" && (
            <form onSubmit={showPaymentInstructions}>
              <label htmlFor="full-name">Full name</label>
              <input
                id="full-name"
                name="fullName"
                type="text"
                autoComplete="name"
                placeholder="e.g. Amina Wanjiku"
                value={fullName}
                maxLength={120}
                onChange={(event) => setFullName(event.target.value)}
                required
              />
              <label htmlFor="phone-number">M-Pesa phone number</label>
              <input
                id="phone-number"
                name="phoneNumber"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="e.g. 0712 345 678"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                required
              />
              <p className="field-hint">
                We’ll send the payment prompt to this number. Never enter your
                M-Pesa PIN or OTP on this website.
              </p>
              <button className="primary-button" type="submit">
                Continue <span aria-hidden="true">→</span>
              </button>
              {!canBook && (
                <p className="setup-note">
                  The organizer is preparing bookings. Please check back soon.
                </p>
              )}
            </form>
          )}

          {stage === "payment" && (
            <form onSubmit={requestPayment}>
              <div className="payment-panel">
                <span className="fact-label">PAY WITH M-PESA</span>
                <p className="payment-intro">
                  We’ll send an M-Pesa prompt to {phoneNumber}. Check your
                  phone and enter your M-Pesa PIN there to approve payment.
                </p>
                <dl className="payment-details">
                  <div>
                    <dt>
                      {eventConfig.businessType === "PAYBILL" ? "Paybill" : "Till"}
                    </dt>
                    <dd>{eventConfig.businessShortcode}</dd>
                  </div>
                  <div>
                    <dt>Business name</dt>
                    <dd>{eventConfig.businessName}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>{formatPrice(eventConfig.ticketPriceKes)}</dd>
                  </div>
                </dl>
              </div>
              <button
                className="primary-button"
                type="submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Sending prompt…
                  </>
                ) : (
                  <>
                    Send payment prompt <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
              <p className="verification-note">
                A ticket is confirmed only after Safaricom confirms the payment.
              </p>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setStage("details");
                  setMessage(null);
                }}
                disabled={isSubmitting}
              >
                Back
              </button>
            </form>
          )}

          {stage === "waiting" && (
            <div className="success-content">
              {paymentStatus === "Pending Verification" && (
                <span
                  className="spinner payment-spinner"
                  aria-hidden="true"
                />
              )}
              {paymentStatus === "Paid" && (
                <span className="success-icon" aria-hidden="true">
                  <CheckIcon />
                </span>
              )}
              <p className="verification-note">
                {paymentStatus === "Paid"
                  ? `Booking ID: ${activeBooking?.bookingId}`
                  : paymentStatus === "Rejected"
                    ? "No ticket has been confirmed. You can try again or contact the event organizer."
                    : "Your booking remains pending until the payment is confirmed. Do not retry if you have already approved the prompt."}
              </p>
              {(paymentStatus === "Rejected" || paymentStatus === "Paid") && (
                <button className="text-button" type="button" onClick={startOver}>
                  Make another booking
                </button>
              )}
            </div>
          )}
        </section>
      </section>

      <footer className="site-footer">
        <span>Good things happen when we get together.</span>
        <span>Questions? Contact the event organizer.</span>
      </footer>
    </main>
  );
}

function normalizePhoneNumber(value) {
  const digits = value.replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return "";
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M7.5 3.5v4M16.5 3.5v4M3.5 10h17" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export default App;
