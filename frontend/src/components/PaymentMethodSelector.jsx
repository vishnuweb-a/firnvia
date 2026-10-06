import { PAYMENT_PROVIDERS } from "../utils/payment.js";

/**
 * Radio group for choosing a payment provider. Each row is a <label> wrapping
 * a real radio input, so the whole card is clickable and keyboard arrows move
 * between options without any custom key handling.
 */
export default function PaymentMethodSelector({ value, onChange, disabled }) {
  return (
    <fieldset className="pay-methods" disabled={disabled}>
      <legend>Payment method</legend>
      {PAYMENT_PROVIDERS.map((p) => (
        <label
          key={p.id}
          className={`pay-method${value === p.id ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name="paymentProvider"
            value={p.id}
            checked={value === p.id}
            disabled={disabled}
            onChange={() => onChange(p.id)}
          />
          <span className="pay-method-text">
            <span className="pay-method-name">{p.name}</span>
            <span className="pay-method-blurb">{p.blurb}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
