// SPDX-License-Identifier: Apache-2.0
//
// All HTTP is intercepted: a default-follow signed POST models the misleading final GET 200.
globalThis.fetch = async (_url, init) => {
  if (init?.method === "POST") {
    if (init.redirect === "manual") {
      return new Response("", {
        status: 302,
        headers: { location: "https://example.invalid/r/tclk-offers" },
      });
    }
    return new Response("followed GET, no signed write", { status: 200 });
  }
  // Allow the example's initial note write to reach its first signed POST.
  return new Response("ok", { status: 200 });
};
