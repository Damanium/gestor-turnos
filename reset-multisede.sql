PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS jornadas;
DROP TABLE IF EXISTS technicians;
DROP TABLE IF EXISTS sites;

CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE technicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_pos INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  site_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE jornadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  order_json TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  site_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jornada_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  technician_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  site_id INTEGER NOT NULL
);

INSERT INTO sites (code, name, active)
VALUES
  ('ramirez', 'Consejeria de Eco. Hac. y Empleo - Ramirez de Prado, 5 BIS', 1),
  ('octubre', 'H.U 12 de Octubre - Gta. Málaga, 11', 1);

CREATE INDEX idx_sites_code
  ON sites(code);

CREATE INDEX idx_technicians_site
  ON technicians(site_id);

CREATE INDEX idx_technicians_site_position
  ON technicians(site_id, base_pos, id);

CREATE INDEX idx_jornadas_site
  ON jornadas(site_id);

CREATE INDEX idx_jornadas_site_id
  ON jornadas(site_id, id);

CREATE INDEX idx_assignments_site
  ON assignments(site_id);

CREATE INDEX idx_assignments_jornada_site
  ON assignments(jornada_id, site_id);

CREATE INDEX idx_assignments_created_site
  ON assignments(site_id, created_at);

CREATE UNIQUE INDEX idx_assignments_jornada_seq
  ON assignments(jornada_id, seq, site_id);

PRAGMA foreign_keys = ON;
