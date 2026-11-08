export class ApiError extends Error {
 constructor(code,message,details={}){super(message);this.code=code;this.details=details;}
}
// A definite "no" from the site: the paid request was answered and not accepted. Network errors and 5xx stay uncertain.
export const siteRefused=e=>['login_required','session_expired'].includes(e?.code)||[400,401,403,419,422,429].includes(e?.details?.httpStatus);
