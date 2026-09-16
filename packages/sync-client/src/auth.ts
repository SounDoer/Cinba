declare const managementAuthorizationBrand: unique symbol;
declare const coreAuthorizationBrand: unique symbol;
declare const enrollmentAuthorizationBrand: unique symbol;

export type ManagementAuthorization = {
  readonly csrfToken: string;
  readonly cookieHeader?: string;
  readonly [managementAuthorizationBrand]: true;
};

export type CoreAuthorization = {
  readonly token: string;
  readonly [coreAuthorizationBrand]: true;
};

export type EnrollmentAuthorization = {
  readonly secret: string;
  readonly [enrollmentAuthorizationBrand]: true;
};

function requiredSecret(value: string, name: string): string {
  if (value.trim() === "") {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

export function managementAuthorization(
  csrfToken: string,
  cookieHeader?: string,
): ManagementAuthorization {
  return {
    csrfToken: requiredSecret(csrfToken, "CSRF token"),
    ...(cookieHeader ? { cookieHeader } : {}),
  } as ManagementAuthorization;
}

export function coreAuthorization(token: string): CoreAuthorization {
  return { token: requiredSecret(token, "Core credential") } as CoreAuthorization;
}

export function enrollmentAuthorization(secret: string): EnrollmentAuthorization {
  return { secret: requiredSecret(secret, "Enrollment secret") } as EnrollmentAuthorization;
}
