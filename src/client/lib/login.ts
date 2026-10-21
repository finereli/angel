import { FinereliLogin } from '$shared/lib/finereli-login'

// The one sign-in instance: login.finereli.com (Google) in a popup.
export const login = new FinereliLogin({ storageKey: 'angel.login' })
