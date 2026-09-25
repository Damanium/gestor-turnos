# Desplegar la autenticación por sede + panel de administración

La base de datos D1 YA está migrada (columnas de contraseña en `sites` y
tabla `login_attempts` creadas). No hay que tocar D1 a mano, ni se ha
borrado ningún técnico existente.

## 1. Configura los secretos del Worker (una sola vez)

Necesitas dos secretos nuevos:

**TOKEN_SECRET** — la clave con la que se firman los tokens de sesión.
Cualquier cadena larga y aleatoria vale:

```
openssl rand -base64 32
```

y luego:

```
wrangler secret put TOKEN_SECRET
```
(pega el valor que te ha dado `openssl`)

**ADMIN_PASSWORD_HASH / ADMIN_PASSWORD_SALT** — la contraseña de
administrador, pero nunca en texto plano. Ejecuta en tu propio ordenador
(la contraseña no sale de tu máquina):

```
node scripts/generar-password.mjs "la-contraseña-que-quieras"
```

Te da dos comandos `wrangler secret put` listos para copiar y pegar.

## 2. Despliega

```
wrangler deploy
```

## 3. Primer acceso

1. Entra en `/admin.html` y accede con la contraseña de administrador que
   acabas de fijar.
2. Verás `ramirez` y `octubre` en la lista, marcadas como "Sin
   contraseña". Ponle una contraseña a cada una (mínimo 6 caracteres).
3. Desde ahí también puedes crear sedes nuevas o desactivar una existente.

## 4. Uso normal

- La URL raíz (`/` o `/index.html`) es ahora la página de acceso: elegir
  sede + contraseña. Recuerda la última sede usada.
- Tras entrar, lleva a `/app.html?site=<código>`, que es la aplicación de
  siempre.
- Las sesiones duran 12 horas. Tras 3 fallos seguidos (por sede o en el
  login de admin), esa combinación sede+IP queda bloqueada 30 segundos.
- "Cambiar de sede" en la cabecera de la app cierra la sesión y vuelve a
  la página de acceso.

## Notas

- Los tokens son HMAC firmados con `TOKEN_SECRET`, sin librerías (JWT
  hecho a mano con `crypto.subtle`). Si cambias `TOKEN_SECRET`, todas las
  sesiones abiertas se invalidan de golpe (útil si sospechas que un token
  se ha filtrado).
- Las contraseñas de sede se guardan como PBKDF2 (100.000 iteraciones) +
  sal en D1, nunca en texto plano.
- La contraseña de administrador NO está en D1, solo en los secretos del
  Worker, así que aunque alguien leyera la base de datos entera no podría
  entrar como admin.
