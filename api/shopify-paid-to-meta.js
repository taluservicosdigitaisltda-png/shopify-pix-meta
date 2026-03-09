import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // 1) Validação do webhook (HMAC)
    const shopifySecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    const rawBody = await getRawBody(req);

    const generatedHmac = crypto
      .createHmac("sha256", shopifySecret)
      .update(rawBody, "utf8")
      .digest("base64");

    const safeCompare = (a, b) => {
      const buffA = Buffer.from(a || "", "utf8");
      const buffB = Buffer.from(b || "", "utf8");
      if (buffA.length !== buffB.length) return false;
      return crypto.timingSafeEqual(buffA, buffB);
    };

    if (!safeCompare(generatedHmac, hmacHeader)) {
      return res.status(401).send("Invalid webhook signature");
    }

    // 2) Parse do pedido
    const order = JSON.parse(rawBody);

    console.log("=== WEBHOOK RECEBIDO ===");
    console.log("order_id:", order.id, "order_number:", order.order_number);
    console.log("payment_gateway_names:", order.payment_gateway_names);
    console.log("financial_status:", order.financial_status);

    const financialStatus = String(order.financial_status || "").toLowerCase();

    // 3) Só envia evento se o pedido estiver realmente pago
    if (financialStatus !== "paid") {
      console.log("Evento ignorado: pedido não pago");
      return res.status(200).json({
        ok: true,
        sent: false,
        reason: `financial_status=${financialStatus}`,
      });
    }

    // 4) Detectar gateway
    const gateways = (order.payment_gateway_names || []).map((g) =>
      String(g).toLowerCase()
    );

    const gatewayText = gateways.join(" ");

    const isPix = gateways.some((g) => g.includes("pix"));

    const isCard = gateways.some(
      (g) =>
        g.includes("card") ||
        g.includes("credit") ||
        g.includes("visa") ||
        g.includes("mastercard") ||
        g.includes("master") ||
        g.includes("amex") ||
        g.includes("american express") ||
        g.includes("elo") ||
        g.includes("hipercard") ||
        g.includes("shopify payments")
    );

    console.log("gateways_lower:", gateways);
    console.log("isPix:", isPix);
    console.log("isCard:", isCard);

    if (!isPix && !isCard) {
      console.log("Evento ignorado: gateway não mapeado");
      return res.status(200).json({
        ok: true,
        sent: false,
        reason: "gateway_not_mapped",
        gateways,
      });
    }

    const eventName = isPix ? "PurchasePix" : "PurchaseCard";
    console.log("eventName:", eventName);

    // 5) Configuração Meta CAPI
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const testCode = process.env.META_TEST_CODE; // opcional

    const eventTime = Math.floor(Date.now() / 1000);

    const currency = order.currency || "BRL";
    const value = order.current_total_price
      ? Number(order.current_total_price)
      : Number(order.total_price || 0);

    // Dados do usuário
    const email = order.email ? hash(order.email.trim().toLowerCase()) : undefined;
    const phone = order.phone ? hash(normalizePhone(order.phone)) : undefined;

    // event_id para deduplicação
    const eventId = `${isPix ? "pix" : "card"}_${order.id}_${order.order_number}`;

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          action_source: "website",
          event_id: eventId,
          user_data: cleanUndefined({
            em: email ? [email] : undefined,
            ph: phone ? [phone] : undefined,
            client_ip_address: req.headers["x-forwarded-for"]?.split(",")[0],
            client_user_agent: req.headers["user-agent"],
          }),
          custom_data: {
            currency,
            value,
            order_id: String(order.id),
            order_number: String(order.order_number),
            payment_method: isPix ? "pix" : "card",
            payment_status: financialStatus,
            payment_gateway: gatewayText,
          },
        },
      ],
    };

    const url = new URL(`https://graph.facebook.com/v20.0/${pixelId}/events`);
    url.searchParams.set("access_token", accessToken);
    if (testCode) {
      url.searchParams.set("test_event_code", testCode);
    }

    const metaResp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const metaJson = await metaResp.json();

    console.log("META status:", metaResp.status);
    console.log("META response:", metaJson);

    return res.status(200).json({
      ok: true,
      sent: true,
      eventName,
      paymentMethod: isPix ? "pix" : "card",
      paymentStatus: financialStatus,
      meta: metaJson,
    });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

// Helpers
function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function normalizePhone(phone) {
  return String(phone).replace(/\D/g, "");
}

function cleanUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
