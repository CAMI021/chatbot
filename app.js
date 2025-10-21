// Cargar variables de entorno desde .env
require('dotenv').config();

// Importar las dependencias necesarias del framework
const { createBot, createProvider, createFlow, addKeyword } = require('@bot-whatsapp/bot');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MongoAdapter = require('@bot-whatsapp/database/mongo'); // Adaptador para MongoDB
const mongoose = require('mongoose');

// 1. Leer la conexión a MongoDB Atlas desde una variable de entorno
// Si no se encuentra la variable, el bot mostrará un error y se detendrá
const MONGO_DB_URI = process.env.MONGO_DB_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'citas_db'; // Puedes usar una variable de entorno también para el nombre de la base de datos, o dejar un valor por defecto

if (!MONGO_DB_URI) {
  console.error("❌ Error: La variable de entorno MONGO_DB_URI no está definida.");
  console.error("Asegúrate de definirla en tu entorno local (.env) o en tu plataforma de despliegue (Railway, Render, etc.).");
  process.exit(1); // Detiene la ejecución si no hay URI
}

const CITAS_COLLECTION_NAME = 'citas'; // Nombre de la colección

// 2. Definición del modelo de Cita (una sola vez)
let CitaModel; // Variable global para almacenar el modelo compilado

const initCitaModel = () => {
    if (!CitaModel) {
        const citaSchema = new mongoose.Schema({
            _id: { type: String, required: true }, // Clave compuesta: "fechaISO|hora"
            fecha: { type: String, required: true },
            hora: { type: String, required: true },
            usuario: { type: String, required: true },
            timestamp: { type: String, required: true },
        });
        // Crear el modelo, asegurando que la colección se llame 'citas'
        CitaModel = mongoose.model(CITAS_COLLECTION_NAME, citaSchema, CITAS_COLLECTION_NAME);
    }
    return CitaModel;
};

// 3. Funciones para interactuar con la base de datos MongoDB
/**
 * Conecta a la base de datos y obtiene el modelo de citas.
 * @returns {mongoose.Model} El modelo de la colección de citas.
 */
const getCitasCollection = async () => {
    if (mongoose.connection.readyState !== 1) { // 1 = Conectado
        await mongoose.connect(MONGO_DB_URI, { dbName: MONGO_DB_NAME });
        console.log('✅ Conexión a MongoDB Atlas establecida.');
        initCitaModel(); // Inicializar el modelo solo después de conectar
    }
    return CitaModel; // Devolver el modelo ya compilado
};

/**
 * Carga todas las citas desde MongoDB.
 * @returns {Object} Un objeto donde las claves son "fechaISO|hora" y los valores son los datos de la cita.
 */
const cargarCitas = async () => {
    try {
        const CitaModel = await getCitasCollection();
        const citasDB = await CitaModel.find({});

        // Transformar el array de documentos en un objeto como el del JSON
        const citasObj = {};
        citasDB.forEach(cita => {
            citasObj[cita._id] = {
                fecha: cita.fecha,
                hora: cita.hora,
                usuario: cita.usuario,
                timestamp: cita.timestamp,
            };
        });
        return citasObj;
    } catch (err) {
        console.error('Error al cargar citas desde MongoDB:', err);
        throw new Error('No se pudieron cargar las citas desde la base de datos.');
    }
};

/**
 * Guarda una nueva cita en MongoDB.
 * @param {string} clave - La clave compuesta "fechaISO|hora".
 * @param {Object} datosCita - Los datos de la cita a guardar.
 */
const guardarCita = async (clave, datosCita) => {
    try {
        const CitaModel = await getCitasCollection();
        const nuevaCita = new CitaModel({
            _id: clave, // Usamos la clave como _id
            ...datosCita
        });
        await nuevaCita.save();
        console.log(`✅ Cita guardada exitosamente: ${clave} para usuario ${datosCita.usuario}`);
    } catch (err) {
        console.error('Error al guardar cita en MongoDB:', err);
        if (err.code === 11000) {
             // Código 11000 es un error de clave duplicada en MongoDB
            console.error('❌ Error: La cita ya existe (clave duplicada).');
            throw new Error('Ese horario ya fue reservado. Por favor inicia de nuevo con *hola*.');
        }
        throw new Error('No se pudo guardar la cita en la base de datos.');
    }
};

// 4. Lógica de generación de días disponibles (sin cambios)
function generarDiasDisponibles() {
    const dias = [];
    const fecha = new Date();
    while (dias.length < 5) {
        fecha.setDate(fecha.getDate() + 1);
        const diaSemana = fecha.getDay();
        if (diaSemana >= 1 && diaSemana <= 5) {
            const nombre = fecha.toLocaleDateString('es-ES', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            }).replace(/ de /g, ' ');
            dias.push({
                fechaISO: fecha.toISOString().split('T')[0], // Solo la parte de la fecha
                nombre
            });
        }
    }
    return dias;
}

const HORARIOS = ['9:00 AM', '10:30 AM', '1:00 PM', '3:30 PM', '5:00 PM'];

// 5. Definición del flujo de agendamiento de citas
const flowCita = addKeyword(['hola', 'Hola'], { sensitive: false })
    .addAnswer('🙌 ¡Perfecto! Te ayudo a agendar tu cita. Por favor selecciona uno de estos días disponibles:', null, async (_, { flowDynamic, state }) => {
        const dias = generarDiasDisponibles();
        await state.update({ diasDisponibles: dias });
        const opciones = dias.map((d, i) => `${i + 1}. ${d.nombre}`).join('\n');
        await flowDynamic(`\n${opciones}\n\nResponde con el número de tu preferencia.`);
    })
    .addAnswer('⏳ Validando tu selección...', { capture: true }, async (ctx, { flowDynamic, state, fallBack }) => {
        const dias = state.get('diasDisponibles');
        const num = parseInt(ctx.body);

        if (isNaN(num) || num < 1 || num > dias.length) {
            await flowDynamic('⚠️ Por favor, responde con un número válido (1 al 5).');
            return fallBack();
        }

        const diaSeleccionado = dias[num - 1];

        // LEER CITAS EN TIEMPO REAL desde MongoDB
        const citas = await cargarCitas();

        // Filtrar SOLO horarios libres
        const horariosDisponibles = HORARIOS.filter(hora => {
            const clave = `${diaSeleccionado.fechaISO}|${hora}`;
            return !citas[clave];
        });

        if (horariosDisponibles.length === 0) {
            await flowDynamic([
                `❌ Lo siento, ya no hay horarios disponibles para el ${diaSeleccionado.nombre}.`,
                'Por favor escribe *hola* nuevamente para ver otras fechas.'
            ]);
            return;
        }

        await state.update({ diaSeleccionado, horariosDisponibles });

        const listaHorarios = horariosDisponibles.map((h, i) => `${i + 1}. ${h}`).join('\n');
        await flowDynamic([
            `Excelente, has seleccionado el ${diaSeleccionado.nombre}. Horarios disponibles:`,
            '',
            listaHorarios,
            '',
            'Responde con el número del horario que prefieras.'
        ]);
    })
    .addAnswer('⏳ Validando horario...', { capture: true }, async (ctx, { flowDynamic, state }) => {
        const { diaSeleccionado, horariosDisponibles } = state.getMyState();
        const num = parseInt(ctx.body);

        if (isNaN(num) || num < 1 || num > horariosDisponibles.length) {
            await flowDynamic([
                '⚠️ Opción inválida.',
                'Por favor inicia de nuevo escribiendo *hola*.'
            ]);
            return;
        }

        const horaSeleccionada = horariosDisponibles[num - 1];
        const clave = `${diaSeleccionado.fechaISO}|${horaSeleccionada}`;

        // Volver a leer citas desde MongoDB (por seguridad, evita condiciones de carrera)
        const citas = await cargarCitas();

        if (citas[clave]) {
            await flowDynamic([
                '❌ Ese horario ya fue reservado.',
                'Por favor inicia de nuevo con *hola*.'
            ]);
            return;
        }

        // Preparar los datos de la nueva cita
        const datosNuevaCita = {
            fecha: diaSeleccionado.fechaISO,
            hora: horaSeleccionada,
            usuario: ctx.from,
            timestamp: new Date().toISOString()
        };

        try {
            // Guardar la cita en MongoDB
            await guardarCita(clave, datosNuevaCita);

            await flowDynamic([
                '✅ ¡Cita confirmada!',
                `📅 Fecha: ${diaSeleccionado.nombre}`,
                `🕒 Hora: ${horaSeleccionada}`
            ]);
        } catch (error) {
             // Manejar el error si la cita ya existía o no se pudo guardar
            console.error("Error en el flujo de guardado:", error.message);
            await flowDynamic(error.message || 'Hubo un problema al confirmar tu cita. Inténtalo de nuevo.');
        }
    });

// 6. Función principal para iniciar el bot
const main = async () => {
    // Configurar el adaptador de base de datos MongoDB (este adaptador es para almacenar mensajes internos del bot, no nuestras citas)
    const adapterDB = new MongoAdapter({
        dbUri: MONGO_DB_URI,
        dbName: MONGO_DB_NAME,
    });

    // Crear el flujo principal basado en el flujo de citas
    const adapterFlow = createFlow([flowCita]);

    // Configurar el proveedor (Baileys para WhatsApp)
    const adapterProvider = createProvider(BaileysProvider);

    // Crear el bot con los adaptadores
    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB, // Asegúrate de pasar el adaptador de DB
    });

    // Manejar cierre de conexión de mongoose si el proceso termina
    process.on('SIGINT', async () => {
        console.log('\nCerrando conexión con MongoDB...');
        await mongoose.connection.close();
        console.log('Conexión a MongoDB cerrada.');
        process.exit(0);
    });

};

// Ejecutar la función principal
main().catch(console.error);
