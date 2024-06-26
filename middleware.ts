import { get } from "@vercel/edge-config";
import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};

// Configuration stored in Edge Config.
interface BlueGreenConfig {
  blue: {
    __vdpl: string;
    deploymentUrl: string;
  };
  green: {
    __vdpl: string;
    deploymentUrl: string;
  };
  trafficGreenPercent: number;
  stickySession: boolean;
}

export async function middleware(req: NextRequest) {
  if (!process.env.EDGE_CONFIG) {
    console.warn("EDGE_CONFIG env variable not set. Skipping blue-green.");
    return NextResponse.next();
  }

  // Get the blue-green configuration from Edge Config.
  const blueGreenConfig = await get<BlueGreenConfig>(
    "blue-green-configuration"
  );
  if (!blueGreenConfig) {
    console.warn("No blue-green configuration found");
    return NextResponse.next();
  }

  // Skip if the middleware has already run.
  // this check needs to be done before the rest of the logic in order to add the cookie
  if (req.headers.get("x-deployment-override")) {
    return getDeploymentWithCookieBasedOnEnvVar(req, blueGreenConfig);
  }

  if (
    // We don't want to run blue-green during development.
    process.env.NODE_ENV !== "production" ||
    // We skip blue-green when accesing from deployment urls
    req.nextUrl.hostname === process.env.VERCEL_URL ||
    // We only want to run blue-green for GET requests that are for HTML documents.
    req.method !== "GET" ||
    req.headers.get("sec-fetch-dest") !== "document" ||
    // Skip if the request is coming from Vercel's deployment system.
    /vercel/i.test(req.headers.get("user-agent") || "")
  ) {
    return NextResponse.next();
  }

  // Retrieve the existing deployment ID from the cookie
  const existingDeployment = req.cookies.get("__vdpl")?.value || "";

  // If there's an existing deployment and it's a valid domain, serve from it
  if (
    blueGreenConfig.stickySession &&
    existingDeployment &&
    isValidDeployment(blueGreenConfig, existingDeployment)
  ) {
    const existingDeploymentDomain =
      existingDeployment === blueGreenConfig.blue.__vdpl
        ? blueGreenConfig.blue.deploymentUrl
        : blueGreenConfig.green.deploymentUrl;

    console.info(
      "Serving from existing deployment domain:",
      existingDeploymentDomain
    );
    return getNextResponse(req, existingDeploymentDomain);
  }

  const servingDeploymentDomain = process.env.VERCEL_URL;
  const selectedDeploymentDomain =
    selectBlueGreenDeploymentDomain(blueGreenConfig);
  console.info(
    "Selected deployment domain",
    selectedDeploymentDomain,
    blueGreenConfig
  );
  if (!selectedDeploymentDomain) {
    return NextResponse.next();
  }
  // The selected deployment domain is the same as the one serving the request.
  if (servingDeploymentDomain === selectedDeploymentDomain) {
    return getDeploymentWithCookieBasedOnEnvVar(req, blueGreenConfig);
  }
  return getNextResponse(req, selectedDeploymentDomain);
}

function formatDeploymentUrl(deploymentUrl: string) {
  if (/^http/.test(deploymentUrl || "")) {
    return new URL(deploymentUrl || "").hostname;
  }
  return deploymentUrl;
}

function getNextResponse(req: NextRequest, domain: string) {
  // make sure always to use the hostname only
  const formattedDomain = formatDeploymentUrl(domain);

  // Fetch the HTML document from the selected deployment domain and return it to the user.
  const headers = new Headers(req.headers);
  headers.set("x-deployment-override", formattedDomain);
  headers.set(
    "x-vercel-protection-bypass",
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "unknown"
  );
  const url = new URL(req.url);
  url.hostname = formattedDomain;
  return fetch(url, {
    headers,
    redirect: "manual",
  });
}

function isValidDeployment(config: BlueGreenConfig, deployment: string) {
  return (
    deployment === config.blue.__vdpl || deployment === config.green.__vdpl
  );
}

// Selects the deployment domain based on the blue-green configuration.
function selectBlueGreenDeploymentDomain(blueGreenConfig: BlueGreenConfig) {
  const random = Math.random() * 100;

  const selected =
    random < blueGreenConfig.trafficGreenPercent
      ? blueGreenConfig.green.deploymentUrl
      : blueGreenConfig.blue.deploymentUrl || process.env.VERCEL_URL || "";
  if (!selected) {
    console.error("Blue green configuration error", blueGreenConfig);
  }

  return formatDeploymentUrl(selected);
}

function getDeploymentWithCookieBasedOnEnvVar(
  req: NextRequest,
  config: BlueGreenConfig
) {
  console.log(
    "Setting cookie based on env var",
    process.env.VERCEL_DEPLOYMENT_ID
  );
  const response = NextResponse.next();

  let __vdpl = process.env.VERCEL_DEPLOYMENT_ID || "";

  // Retrieve the existing deployment ID from the cookie
  const existingDeployment = req.cookies.get("__vdpl")?.value || "";

  if (
    config.stickySession &&
    existingDeployment &&
    isValidDeployment(config, existingDeployment)
  ) {
    // use the same deployment as before
    // so basically stop randomizing the deployment
    __vdpl = existingDeployment;
  }

  // We need to set this cookie because next.js does not do this by default, but we do want
  // the deployment choice to survive a client-side navigation.
  // set for the green deployment (production == green == VERCEL_DEPLOYMENT_ID)
  response.cookies.set("__vdpl", __vdpl, {
    sameSite: "strict",
    httpOnly: true,
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return response;
}
