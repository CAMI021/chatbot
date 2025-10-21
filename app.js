// app.js
const { createBot, createProvider, createFlow, addKeyword } = require('@bot-whatsapp/bot')
const BaileysProvider = require('@bot-whatsapp/provider/baileys')
// Reemplazamos JsonFileAdapter por MongoAdapter
const MongoAdapter = require('@bot-whatsapp/database/mongo')

// Generar próximos 5 días laborables (lunes a viernes), SIN incluir hoy
function generarDiasDisponibles() {
    const dias = []
    const fecha = new Date()
    while (dias.length < 5) {
        fecha.setDate(fecha.getDate() + 1)
        const diaSemana = fecha.getDay()
        if (diaSemana >= 1 && diaSemana <= 5) {
            const nombre = fecha.toLocaleDateString('es-ES', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            }).replace(/ de /g, ' ')
            dias.push({
                fechaISO: fecha.toISOString().split('T')[0],
                nombre
            })
        }
    }
    return dias
}

const HORARIOS = ['9:00 AM', '10:30 AM', '1:00 PM', '3:30 PM', '5:00 PM']

// Flujo de agendamiento de citas
const flowCita = addKeyword(['hola', 'Hola'], { sensitive: false })
    .addAnswer('🙌 ¡Perfecto! Te ayudo a agendar tu cita. Por favor selecciona uno de estos días disponibles:', null, async (_, { flowDynamic, state }) => {
        const dias = generarDiasDisponibles()
        await state.update({ diasDisponibles: dias })
        const opciones = dias.map((d, i) => `${i + 1}. ${d.nombre}`).join('\n')
        await flowDynamic(`\n${opciones}\n\nResponde con el número de tu preferencia.`)
    })
    .addAnswer('⏳ Validando tu selección...', { capture: true }, async (ctx, { flowDynamic, state, fallBack, database }) => {
        const dias = state.get('diasDisponibles')
        const num = parseInt(ctx.body)

        if (isNaN(num) || num < 1 || num > dias.length) {
            await flowDynamic('⚠️ Por favor, responde con un número válido (1 al 5).')
            return fallBack()
        }

        const diaSeleccionado = dias[num - 1]

        // Cargar citas desde MongoDB
        const citas = await cargarCitasDesdeDB(database)

        // Filtrar SOLO horarios libres
        const horariosDisponibles = HORARIOS.filter(hora => {
            const clave = `${diaSeleccionado.fechaISO}|${hora}`
            return !citas[clave]
        })

        if (horariosDisponibles.length === 0) {
            await flowDynamic([
                `❌ Lo siento, ya no hay horarios disponibles para el ${diaSeleccionado.nombre}.`,
                'Por favor escribe *hola* nuevamente para ver otras fechas.'
            ])
            return
        }

        await state.update({ diaSeleccionado, horariosDisponibles })

        const listaHorarios = horariosDisponibles.map((h, i) => `${i + 1}. ${h}`).join('\n')
        await flowDynamic([
            `Excelente, has seleccionado el ${diaSeleccionado.nombre}. Horarios disponibles:`,
            '',
            listaHorarios,
            '',
            'Responde con el número del horario que prefieras.'
        ])
    })
    .addAnswer('⏳ Validando horario...', { capture: true }, async (ctx, { flowDynamic, state, database }) => {
        const { diaSeleccionado, horariosDisponibles } = state.getMyState()
        const num = parseInt(ctx.body)

        if (isNaN(num) || num < 1 || num > horariosDisponibles.length) {
            await flowDynamic([
                '⚠️ Opción inválida.',
                'Por favor inicia de nuevo escribiendo *hola*.'
            ])
            return
        }

        const horaSeleccionada = horariosDisponibles[num - 1]
        const clave = `${diaSeleccionado.fechaISO}|${horaSeleccionada}`

        // Volver a leer citas (por seguridad, evita condiciones de carrera)
        const citas = await cargarCitasDesdeDB(database)

        if (citas[clave]) {
            await flowDynamic([
                '❌ Ese horario ya fue reservado.',
                'Por favor inicia de nuevo con *hola*.'
            ])
            return
        }

        // Guardar la cita en MongoDB
        await guardarCitaEnDB(database, {
            fecha: diaSeleccionado.fechaISO,
            hora: horaSeleccionada,
            usuario: ctx.from,
            timestamp: new Date().toISOString()
        })

        await flowDynamic([
            '✅ ¡Cita confirmada!',
            `📅 Fecha: ${diaSeleccionado.nombre}`,
            `🕒 Hora: ${horaSeleccionada}`
        ])
    })

// --- Funciones auxiliares para leer/escribir en MongoDB ---
async function cargarCitasDesdeDB(adapterDB) {
    const db = adapterDB.db
    const citas = await db.collection('citas').find({}).toArray()
    const mapa = {}
    citas.forEach(c => {
        mapa[`${c.fecha}|${c.hora}`] = c
    })
    return mapa
}

async function guardarCitaEnDB(adapterDB, cita) {
    const db = adapterDB.db
    await db.collection('citas').insertOne(cita)
}

// --- Iniciar el bot ---
const main = async () => {
    // Usamos el adaptador de MongoDB
    const adapterDB = new MongoAdapter({
        uri: process.env.MONGODB_URL // Usamos la variable de entorno
    })

    const adapterFlow = createFlow([flowCita])
    // Pasamos adapterDB también al proveedor para guardar la sesión
    const adapterProvider = createProvider(BaileysProvider, {
        database: adapterDB,
        showQR: true // Mostrará el QR en la consola
    })

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })
}

main().catch(console.error)