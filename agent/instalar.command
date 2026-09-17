#!/bin/bash
# Instalador de ReWatch. Doble clic y sigue las instrucciones.
# Deja el agente listo: Telegram conectado, una primera revision hecha y un
# acceso directo en el Escritorio para arrancarlo cada dia.

cd "$(dirname "$0")" || exit 1

echo ""
echo "=========================================="
echo "   ReWatch - instalacion"
echo "=========================================="
echo ""

# ---- 1. Node ----
if ! command -v node >/dev/null 2>&1; then
  echo "FALTA NODE.JS."
  echo ""
  echo "Es el programa que hace funcionar el agente. Se instala una sola vez:"
  echo "  1. Abre https://nodejs.org"
  echo "  2. Descarga el boton verde de la izquierda (LTS)"
  echo "  3. Instalalo y vuelve a hacer doble clic en este fichero"
  echo ""
  read -r -p "Pulsa Enter para cerrar."
  exit 1
fi

MAYOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAYOR" -lt 20 ]; then
  echo "Tu Node.js es la version $MAYOR y hace falta la 20 o superior."
  echo "Actualizalo en https://nodejs.org y vuelve a hacer doble clic aqui."
  echo ""
  read -r -p "Pulsa Enter para cerrar."
  exit 1
fi
echo "1/4  Node.js $(node -v) ... correcto"

# ---- 2. Dependencias (opcionales) ----
echo "2/4  Preparando..."
npm install --no-audit --no-fund --silent >/dev/null 2>&1 || true
echo "     listo"

# ---- 3. Telegram ----
echo ""
echo "3/4  Ahora vamos a conectar Telegram."
echo "     Te va a ir pidiendo las cosas una a una. Si te lias, escribe q"
echo "     y vuelve a hacer doble clic en este fichero para empezar de nuevo."
echo ""
node src/index.js --test-telegram
if [ $? -ne 0 ]; then
  echo ""
  echo "Telegram no quedo conectado. El agente funcionaria igual, pero solo"
  echo "avisaria por pantalla. Vuelve a hacer doble clic aqui cuando quieras."
  echo ""
  read -r -p "Pulsa Enter para cerrar."
  exit 1
fi

# ---- 4. Primera revision + acceso directo ----
echo ""
echo "4/4  Primera revision de Vinted."
echo ""
echo "     Los resultados salen por PANTALLA, no por Telegram: ahora mismo hay"
echo "     muchos anuncios que encajan y no tiene sentido mandarte 80 mensajes"
echo "     de golpe. Miralos aqui abajo y compra lo que te interese."
echo ""
echo "     A partir de este momento, Telegram solo te avisara de anuncios NUEVOS."
echo ""
read -r -p "Pulsa Enter para empezar a buscar..."
echo ""
TELEGRAM_BOT_TOKEN= node src/index.js --once

LANZADOR="$HOME/Desktop/ReWatch.command"
cat > "$LANZADOR" <<LANZA
#!/bin/bash
cd "$PWD" || exit 1
echo "ReWatch en marcha. Deja esta ventana abierta."
echo "Para pararlo: Ctrl+C"
echo ""
exec caffeinate -i node src/index.js --watch
LANZA
chmod +x "$LANZADOR"

echo ""
echo "=========================================="
echo "   INSTALADO"
echo "=========================================="
echo ""
echo "Tienes un ReWatch.command en el Escritorio."
echo "Doble clic ahi y el agente se queda vigilando Vinted."
echo ""
echo "Consejos:"
echo "  - Deja la ventana abierta. Si la cierras, el agente se para."
echo "  - Con caffeinate aguanta la pantalla cerrada, pero el Mac tiene que"
echo "    estar enchufado a la corriente."
echo ""
read -r -p "Pulsa Enter para cerrar."
