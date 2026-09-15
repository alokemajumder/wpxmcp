<?php
/**
 * Editable fields.
 *
 * Field groups registered here render as native meta boxes (or a settings page)
 * in wp-admin and are exposed to the REST API. Values are stored as ordinary
 * post meta and options, so the site's content survives if this plugin is ever
 * removed — only the editing UI goes away.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Field groups.
 */
class WPXMCP_Fields {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Fields|null
	 */
	private static $instance = null;

	/**
	 * Option holding all registered groups.
	 */
	const OPTION = 'wpxmcp_field_groups';

	/**
	 * Supported field types.
	 */
	const TYPES = array( 'text', 'textarea', 'wysiwyg', 'number', 'email', 'url', 'date', 'select', 'checkbox', 'radio', 'color', 'image', 'gallery', 'repeater' );

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Fields
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		add_action( 'init', array( $this, 'register_meta' ) );
		add_action( 'add_meta_boxes', array( $this, 'add_meta_boxes' ) );
		add_action( 'save_post', array( $this, 'save_post_fields' ), 10, 2 );
		add_action( 'admin_menu', array( $this, 'add_settings_page' ) );
		add_action( 'admin_init', array( $this, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
	}

	/**
	 * All registered groups.
	 *
	 * @return array
	 */
	public static function groups() {
		$groups = get_option( self::OPTION, array() );
		return is_array( $groups ) ? $groups : array();
	}

	/* ------------------------------------------------------------------ *
	 * REST
	 * ------------------------------------------------------------------ */

	/**
	 * Routes.
	 */
	public function register_routes() {
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( WPXMCP_NAMESPACE, '/fields', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'rest_list' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'rest_register' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( WPXMCP_NAMESPACE, '/fields/(?P<group_key>[a-zA-Z0-9_\-]+)', array(
			'methods'             => WP_REST_Server::DELETABLE,
			'callback'            => array( $this, 'rest_delete' ),
			'permission_callback' => $admin,
		) );
	}

	/**
	 * List groups.
	 *
	 * @return array
	 */
	public function rest_list() {
		$groups = self::groups();
		return array(
			'count'  => count( $groups ),
			'groups' => array_values( $groups ),
			'note'   => empty( $groups ) ? 'No field groups are registered yet. Use register_fields to create one.' : null,
		);
	}

	/**
	 * Register or replace a group.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_register( $request ) {
		$key     = sanitize_key( (string) $request->get_param( 'group_key' ) );
		$title   = sanitize_text_field( (string) $request->get_param( 'title' ) );
		$context = (string) $request->get_param( 'context' );
		$context = in_array( $context, array( 'post_meta', 'options' ), true ) ? $context : 'post_meta';
		$fields  = $request->get_param( 'fields' );

		if ( '' === $key ) {
			return new WP_Error( 'wpxmcp_no_key', 'Supply a `group_key`.', array( 'status' => 400 ) );
		}
		if ( ! is_array( $fields ) || empty( $fields ) ) {
			return new WP_Error( 'wpxmcp_no_fields', 'Supply at least one field.', array( 'status' => 400 ) );
		}

		$post_types = (array) $request->get_param( 'post_types' );
		$post_types = array_values( array_filter( array_map( 'sanitize_key', $post_types ) ) );

		if ( 'post_meta' === $context && empty( $post_types ) ) {
			return new WP_Error( 'wpxmcp_no_post_types', 'A post_meta group needs `post_types` — say which content types show this meta box.', array( 'status' => 400 ) );
		}

		$clean  = array();
		$errors = array();

		foreach ( $fields as $field ) {
			$field_key = sanitize_key( (string) ( $field['key'] ?? '' ) );
			$type      = (string) ( $field['type'] ?? 'text' );

			if ( '' === $field_key ) {
				$errors[] = 'A field is missing its `key`.';
				continue;
			}
			// An options-context field is registered as a setting and saved with
			// update_option(), and every field is exposed to core REST. A key naming a
			// protected option (or this plugin's own state, such as wpxmcp_snippets)
			// would let the settings endpoint write it and bypass those safeguards.
			if ( 0 === strpos( $field_key, 'wpxmcp_' ) || ( 'options' === $context && wpxmcp_is_protected_option( $field_key ) ) ) {
				$errors[] = sprintf( 'Field key "%s" is reserved — it names a protected option. Choose another key.', $field_key );
				continue;
			}
			if ( 'options' === $context ) {
				$registered = get_registered_settings();
				if ( isset( $registered[ $field_key ] ) && ( ! isset( $registered[ $field_key ]['group'] ) || 'wpxmcp_fields' !== $registered[ $field_key ]['group'] ) ) {
					$errors[] = sprintf( 'Field key "%s" is already a setting registered by WordPress or another plugin; re-registering it would replace its validation. Choose another key.', $field_key );
					continue;
				}
			}
			if ( ! in_array( $type, self::TYPES, true ) ) {
				$errors[] = sprintf( 'Field "%s" has unsupported type "%s". Supported: %s.', $field_key, $type, implode( ', ', self::TYPES ) );
				continue;
			}

			$entry = array(
				'key'         => $field_key,
				'label'       => sanitize_text_field( (string) ( $field['label'] ?? $field_key ) ),
				'type'        => $type,
				'description' => sanitize_text_field( (string) ( $field['description'] ?? '' ) ),
				'default'     => $field['default'] ?? '',
				'required'    => ! empty( $field['required'] ),
				'placeholder' => sanitize_text_field( (string) ( $field['placeholder'] ?? '' ) ),
			);

			if ( in_array( $type, array( 'select', 'radio', 'checkbox' ), true ) ) {
				$choices = array();
				foreach ( (array) ( $field['choices'] ?? array() ) as $choice ) {
					$choices[] = array(
						'value' => sanitize_text_field( (string) ( $choice['value'] ?? '' ) ),
						'label' => sanitize_text_field( (string) ( $choice['label'] ?? $choice['value'] ?? '' ) ),
					);
				}
				if ( empty( $choices ) ) {
					$errors[] = sprintf( 'Field "%s" is a %s but has no `choices`.', $field_key, $type );
					continue;
				}
				$entry['choices'] = $choices;
			}

			if ( 'number' === $type ) {
				if ( isset( $field['min'] ) ) {
					$entry['min'] = (float) $field['min'];
				}
				if ( isset( $field['max'] ) ) {
					$entry['max'] = (float) $field['max'];
				}
			}

			if ( 'repeater' === $type ) {
				$subs = array();
				foreach ( (array) ( $field['sub_fields'] ?? array() ) as $sub ) {
					$sub_key  = sanitize_key( (string) ( $sub['key'] ?? '' ) );
					$sub_type = (string) ( $sub['type'] ?? 'text' );
					if ( '' === $sub_key || ! in_array( $sub_type, self::TYPES, true ) || 'repeater' === $sub_type ) {
						continue;
					}
					$subs[] = array(
						'key'   => $sub_key,
						'label' => sanitize_text_field( (string) ( $sub['label'] ?? $sub_key ) ),
						'type'  => $sub_type,
						'choices' => isset( $sub['choices'] ) ? (array) $sub['choices'] : null,
					);
				}
				if ( empty( $subs ) ) {
					$errors[] = sprintf( 'Repeater "%s" has no usable `sub_fields` (nested repeaters are not supported).', $field_key );
					continue;
				}
				$entry['sub_fields'] = $subs;
			}

			$clean[] = $entry;
		}

		if ( empty( $clean ) ) {
			return new WP_Error( 'wpxmcp_no_valid_fields', 'No valid fields: ' . implode( ' ', $errors ), array( 'status' => 400 ) );
		}

		$groups         = self::groups();
		$existed        = isset( $groups[ $key ] );
		$groups[ $key ] = array(
			'group_key'   => $key,
			'title'       => $title ? $title : $key,
			'context'     => $context,
			'post_types'  => $post_types,
			'position'    => in_array( (string) $request->get_param( 'position' ), array( 'normal', 'side', 'advanced' ), true ) ? (string) $request->get_param( 'position' ) : 'normal',
			'description' => sanitize_text_field( (string) $request->get_param( 'description' ) ),
			'fields'      => $clean,
			'updated'     => gmdate( 'c' ),
		);

		update_option( self::OPTION, $groups );

		// Expose the new keys immediately, without waiting for the next request.
		$this->register_meta();

		wpxmcp_audit( 'fields register', array( 'group' => $key, 'fields' => count( $clean ) ) );

		return array(
			'group_key'   => $key,
			'replaced'    => $existed,
			'field_count' => count( $clean ),
			'warnings'    => $errors,
			'admin_url'   => 'options' === $context ? admin_url( 'options-general.php?page=wpxmcp-fields' ) : null,
			'note'        => 'Values are stored as standard post meta / options, and are exposed to the REST API so get_content and update_content can read and write them via `meta`.',
		);
	}

	/**
	 * Remove a group, leaving its stored values in place.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_delete( $request ) {
		$key    = sanitize_key( (string) $request->get_param( 'group_key' ) );
		$groups = self::groups();

		if ( ! isset( $groups[ $key ] ) ) {
			return new WP_Error( 'wpxmcp_no_group', sprintf( 'No field group "%s".', $key ), array( 'status' => 404 ) );
		}

		unset( $groups[ $key ] );
		update_option( self::OPTION, $groups );
		wpxmcp_audit( 'fields delete', array( 'group' => $key ) );

		return array(
			'deleted'   => true,
			'group_key' => $key,
			'note'      => 'The stored values were left untouched — re-registering the group exposes them again.',
		);
	}

	/* ------------------------------------------------------------------ *
	 * Registration
	 * ------------------------------------------------------------------ */

	/**
	 * Maps a field type onto a REST schema type.
	 *
	 * @param array $field Field definition.
	 * @return string
	 */
	private function rest_type( $field ) {
		switch ( $field['type'] ) {
			case 'number':
				return 'number';
			case 'gallery':
			case 'repeater':
				return 'array';
			case 'image':
				return 'integer';
			default:
				return 'string';
		}
	}

	/**
	 * A default value whose PHP type matches the registered REST type.
	 *
	 * register_meta() and register_setting() emit a _doing_it_wrong() notice when
	 * the default does not match the declared type — an image field declares
	 * `integer` but carries '' unless the author set one, which fired on every
	 * request. Coercing here keeps the registration valid whatever the author
	 * supplied.
	 *
	 * @param array $field Field definition.
	 * @return mixed
	 */
	private function default_for( $field ) {
		$declared = $this->rest_type( $field );
		$default  = $field['default'] ?? '';

		switch ( $declared ) {
			case 'array':
				return is_array( $default ) ? $default : array();
			case 'integer':
				return is_numeric( $default ) ? (int) $default : 0;
			case 'number':
				return is_numeric( $default ) ? (float) $default : 0;
			default:
				return is_scalar( $default ) ? (string) $default : '';
		}
	}

	/**
	 * Register every field with WordPress so REST can read and write it.
	 */
	public function register_meta() {
		foreach ( self::groups() as $group ) {
			if ( ! is_array( $group ) || empty( $group['fields'] ) || ! is_array( $group['fields'] ) ) {
				continue;
			}
			if ( 'post_meta' === $group['context'] ) {
				foreach ( (array) $group['post_types'] as $post_type ) {
					foreach ( $group['fields'] as $field ) {
						register_post_meta( $post_type, $field['key'], array(
							'type'         => $this->rest_type( $field ),
							'description'  => $field['description'],
							'single'       => true,
							'default'      => $this->default_for( $field ),
							'show_in_rest' => in_array( $field['type'], array( 'gallery', 'repeater' ), true )
								? array( 'schema' => array( 'type' => 'array', 'items' => array( 'type' => 'gallery' === $field['type'] ? 'integer' : 'object' ) ) )
								: true,
							'auth_callback' => static function ( $allowed, $meta_key, $post_id ) {
								return current_user_can( 'edit_post', $post_id );
							},
						) );
					}
				}
				continue;
			}

			foreach ( $group['fields'] as $field ) {
				// Never re-register a protected option as an editable setting, even if
				// an older group stored before that check was added names one.
				if ( wpxmcp_is_protected_option( $field['key'] ) ) {
					continue;
				}
				register_setting( 'wpxmcp_fields', $field['key'], array(
					'type'         => $this->rest_type( $field ),
					'description'  => $field['description'],
					'default'      => $this->default_for( $field ),
					'show_in_rest' => in_array( $field['type'], array( 'gallery', 'repeater' ), true )
						? array( 'schema' => array( 'type' => 'array', 'items' => array( 'type' => 'gallery' === $field['type'] ? 'integer' : 'object' ) ) )
						: true,
				) );
			}
		}
	}

	/* ------------------------------------------------------------------ *
	 * Admin UI
	 * ------------------------------------------------------------------ */

	/**
	 * Media and colour pickers, only on screens that need them.
	 *
	 * @param string $hook Current admin page.
	 */
	public function enqueue_admin_assets( $hook ) {
		$groups = self::groups();
		if ( empty( $groups ) ) {
			return;
		}

		$relevant = in_array( $hook, array( 'post.php', 'post-new.php' ), true ) || false !== strpos( $hook, 'wpxmcp-fields' );
		if ( ! $relevant ) {
			return;
		}

		wp_enqueue_media();
		wp_enqueue_style( 'wp-color-picker' );
		wp_enqueue_script( 'wp-color-picker' );
		wp_enqueue_editor();

		$script = <<<'JS'
( function ( $ ) {
	$( function () {
		$( '.wpxmcp-color' ).wpColorPicker();

		// Media selection for image and gallery fields.
		$( document ).on( 'click', '.wpxmcp-media-select', function ( e ) {
			e.preventDefault();
			var button   = $( this );
			var target   = $( '#' + button.data( 'target' ) );
			var preview  = $( '#' + button.data( 'target' ) + '-preview' );
			var multiple = button.data( 'multiple' ) === 1;

			var frame = wp.media( {
				title: button.data( 'title' ) || 'Select',
				multiple: multiple,
				library: { type: 'image' }
			} );

			frame.on( 'select', function () {
				var selection = frame.state().get( 'selection' );
				var ids = [];
				preview.empty();

				selection.each( function ( item ) {
					var data = item.toJSON();
					ids.push( data.id );
					var src = ( data.sizes && data.sizes.thumbnail ) ? data.sizes.thumbnail.url : data.url;
					preview.append( $( '<img>' ).attr( 'src', src ).css( { width: 72, height: 72, objectFit: 'cover', marginRight: 8, borderRadius: 4 } ) );
				} );

				target.val( ids.join( ',' ) ).trigger( 'change' );
			} );

			frame.open();
		} );

		$( document ).on( 'click', '.wpxmcp-media-clear', function ( e ) {
			e.preventDefault();
			var target = $( '#' + $( this ).data( 'target' ) );
			target.val( '' );
			$( '#' + $( this ).data( 'target' ) + '-preview' ).empty();
		} );

		// Repeater rows.
		$( document ).on( 'click', '.wpxmcp-repeater-add', function ( e ) {
			e.preventDefault();
			var wrap  = $( this ).closest( '.wpxmcp-repeater' );
			var rows  = wrap.find( '.wpxmcp-repeater-rows' );
			var tpl   = wrap.find( '.wpxmcp-repeater-template' ).html();
			var index = rows.children().length;
			rows.append( tpl.replace( /__INDEX__/g, index ) );
		} );

		$( document ).on( 'click', '.wpxmcp-repeater-remove', function ( e ) {
			e.preventDefault();
			$( this ).closest( '.wpxmcp-repeater-row' ).remove();
		} );
	} );
} )( jQuery );
JS;
		wp_add_inline_script( 'wp-color-picker', $script );

		wp_add_inline_style( 'wp-color-picker', '
			.wpxmcp-field { margin-bottom: 18px; }
			.wpxmcp-field > label { display:block; font-weight:600; margin-bottom:4px; }
			.wpxmcp-field .description { color:#646970; font-size:12px; margin-top:4px; }
			.wpxmcp-field input[type=text], .wpxmcp-field input[type=url], .wpxmcp-field input[type=email],
			.wpxmcp-field input[type=number], .wpxmcp-field input[type=date], .wpxmcp-field select,
			.wpxmcp-field textarea { width:100%; max-width:640px; }
			.wpxmcp-repeater-row { border:1px solid #dcdcde; border-radius:4px; padding:12px; margin-bottom:8px; background:#fff; }
			.wpxmcp-media-preview { display:flex; flex-wrap:wrap; margin:6px 0; }
		' );
	}

	/**
	 * Add the meta boxes.
	 */
	public function add_meta_boxes() {
		foreach ( self::groups() as $group ) {
			if ( 'post_meta' !== $group['context'] ) {
				continue;
			}
			foreach ( $group['post_types'] as $post_type ) {
				add_meta_box(
					'wpxmcp-' . $group['group_key'],
					$group['title'],
					array( $this, 'render_meta_box' ),
					$post_type,
					$group['position'],
					'default',
					array( 'group' => $group )
				);
			}
		}
	}

	/**
	 * Render a meta box.
	 *
	 * @param WP_Post $post Post.
	 * @param array   $box  Box args.
	 */
	public function render_meta_box( $post, $box ) {
		$group = $box['args']['group'];
		wp_nonce_field( 'wpxmcp_fields_' . $group['group_key'], 'wpxmcp_nonce_' . $group['group_key'] );

		if ( ! empty( $group['description'] ) ) {
			echo '<p class="description">' . esc_html( $group['description'] ) . '</p>';
		}

		foreach ( $group['fields'] as $field ) {
			$value = get_post_meta( $post->ID, $field['key'], true );
			if ( '' === $value && '' !== $field['default'] ) {
				$value = $field['default'];
			}
			$this->render_field( $field, $value );
		}
	}

	/**
	 * Render a single field control.
	 *
	 * @param array  $field Field definition.
	 * @param mixed  $value Current value.
	 * @param string $name  Input name override.
	 */
	private function render_field( $field, $value, $name = null ) {
		$name = $name ? $name : $field['key'];
		$id   = 'wpxmcp-' . sanitize_html_class( str_replace( array( '[', ']' ), '-', $name ) );

		echo '<div class="wpxmcp-field">';
		echo '<label for="' . esc_attr( $id ) . '">' . esc_html( $field['label'] );
		if ( ! empty( $field['required'] ) ) {
			echo ' <span style="color:#d63638">*</span>';
		}
		echo '</label>';

		switch ( $field['type'] ) {
			case 'textarea':
				printf(
					'<textarea id="%s" name="%s" rows="4" placeholder="%s">%s</textarea>',
					esc_attr( $id ), esc_attr( $name ), esc_attr( $field['placeholder'] ?? '' ), esc_textarea( (string) $value )
				);
				break;

			case 'wysiwyg':
				wp_editor( (string) $value, $id, array(
					'textarea_name' => $name,
					'textarea_rows' => 8,
					'media_buttons' => true,
				) );
				break;

			case 'select':
				printf( '<select id="%s" name="%s">', esc_attr( $id ), esc_attr( $name ) );
				echo '<option value="">' . esc_html__( '— Select —', 'wpxmcp' ) . '</option>';
				foreach ( (array) ( $field['choices'] ?? array() ) as $choice ) {
					printf(
						'<option value="%s" %s>%s</option>',
						esc_attr( $choice['value'] ),
						selected( (string) $value, (string) $choice['value'], false ),
						esc_html( $choice['label'] )
					);
				}
				echo '</select>';
				break;

			case 'radio':
				foreach ( (array) ( $field['choices'] ?? array() ) as $choice ) {
					printf(
						'<label style="display:block;font-weight:400"><input type="radio" name="%s" value="%s" %s> %s</label>',
						esc_attr( $name ), esc_attr( $choice['value'] ),
						checked( (string) $value, (string) $choice['value'], false ),
						esc_html( $choice['label'] )
					);
				}
				break;

			case 'checkbox':
				$selected = is_array( $value ) ? $value : array_filter( explode( ',', (string) $value ) );
				foreach ( (array) ( $field['choices'] ?? array() ) as $choice ) {
					printf(
						'<label style="display:block;font-weight:400"><input type="checkbox" name="%s[]" value="%s" %s> %s</label>',
						esc_attr( $name ), esc_attr( $choice['value'] ),
						checked( in_array( (string) $choice['value'], array_map( 'strval', $selected ), true ), true, false ),
						esc_html( $choice['label'] )
					);
				}
				break;

			case 'color':
				printf(
					'<input type="text" class="wpxmcp-color" id="%s" name="%s" value="%s" data-default-color="%s">',
					esc_attr( $id ), esc_attr( $name ), esc_attr( (string) $value ), esc_attr( (string) ( $field['default'] ?? '' ) )
				);
				break;

			case 'image':
			case 'gallery':
				$multiple = 'gallery' === $field['type'] ? 1 : 0;
				$ids      = is_array( $value ) ? $value : array_filter( explode( ',', (string) $value ) );

				printf( '<div class="wpxmcp-media-preview" id="%s-preview">', esc_attr( $id ) );
				foreach ( $ids as $attachment_id ) {
					$thumb = wp_get_attachment_image_url( (int) $attachment_id, 'thumbnail' );
					if ( $thumb ) {
						printf( '<img src="%s" style="width:72px;height:72px;object-fit:cover;margin-right:8px;border-radius:4px">', esc_url( $thumb ) );
					}
				}
				echo '</div>';

				printf(
					'<input type="hidden" id="%s" name="%s" value="%s">',
					esc_attr( $id ), esc_attr( $name ), esc_attr( implode( ',', array_map( 'intval', $ids ) ) )
				);
				printf(
					'<button class="button wpxmcp-media-select" data-target="%s" data-multiple="%d" data-title="%s">%s</button> ',
					esc_attr( $id ), (int) $multiple, esc_attr( $field['label'] ),
					esc_html( 'gallery' === $field['type'] ? __( 'Select images', 'wpxmcp' ) : __( 'Select image', 'wpxmcp' ) )
				);
				printf(
					'<button class="button-link wpxmcp-media-clear" data-target="%s">%s</button>',
					esc_attr( $id ), esc_html__( 'Clear', 'wpxmcp' )
				);
				break;

			case 'repeater':
				$rows = is_array( $value ) ? $value : array();
				echo '<div class="wpxmcp-repeater">';
				echo '<div class="wpxmcp-repeater-rows">';
				foreach ( $rows as $index => $row ) {
					echo '<div class="wpxmcp-repeater-row">';
					foreach ( (array) $field['sub_fields'] as $sub ) {
						$sub_field = array_merge( array( 'description' => '', 'placeholder' => '', 'default' => '', 'required' => false ), $sub );
						$this->render_field( $sub_field, $row[ $sub['key'] ] ?? '', sprintf( '%s[%d][%s]', $name, $index, $sub['key'] ) );
					}
					echo '<button class="button-link wpxmcp-repeater-remove" style="color:#d63638">' . esc_html__( 'Remove row', 'wpxmcp' ) . '</button>';
					echo '</div>';
				}
				echo '</div>';

				// Template for new rows; __INDEX__ is substituted client-side.
				echo '<script type="text/template" class="wpxmcp-repeater-template">';
				echo '<div class="wpxmcp-repeater-row">';
				foreach ( (array) $field['sub_fields'] as $sub ) {
					$sub_field = array_merge( array( 'description' => '', 'placeholder' => '', 'default' => '', 'required' => false ), $sub );
					$this->render_field( $sub_field, '', sprintf( '%s[__INDEX__][%s]', $name, $sub['key'] ) );
				}
				echo '<button class="button-link wpxmcp-repeater-remove" style="color:#d63638">' . esc_html__( 'Remove row', 'wpxmcp' ) . '</button>';
				echo '</div>';
				echo '</script>';

				echo '<button class="button wpxmcp-repeater-add">' . esc_html__( 'Add row', 'wpxmcp' ) . '</button>';
				echo '</div>';
				break;

			case 'number':
				printf(
					'<input type="number" id="%s" name="%s" value="%s" %s %s step="any">',
					esc_attr( $id ), esc_attr( $name ), esc_attr( (string) $value ),
					isset( $field['min'] ) ? 'min="' . esc_attr( (string) $field['min'] ) . '"' : '',
					isset( $field['max'] ) ? 'max="' . esc_attr( (string) $field['max'] ) . '"' : ''
				);
				break;

			default:
				$input_type = in_array( $field['type'], array( 'email', 'url', 'date' ), true ) ? $field['type'] : 'text';
				printf(
					'<input type="%s" id="%s" name="%s" value="%s" placeholder="%s">',
					esc_attr( $input_type ), esc_attr( $id ), esc_attr( $name ),
					esc_attr( (string) $value ), esc_attr( $field['placeholder'] ?? '' )
				);
		}

		if ( ! empty( $field['description'] ) ) {
			echo '<p class="description">' . esc_html( $field['description'] ) . '</p>';
		}
		echo '</div>';
	}

	/**
	 * Persist meta box values.
	 *
	 * @param int     $post_id Post ID.
	 * @param WP_Post $post    Post.
	 */
	public function save_post_fields( $post_id, $post ) {
		if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
			return;
		}
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}

		foreach ( self::groups() as $group ) {
			if ( 'post_meta' !== $group['context'] || ! in_array( $post->post_type, $group['post_types'], true ) ) {
				continue;
			}

			$nonce_field = 'wpxmcp_nonce_' . $group['group_key'];
			// phpcs:ignore WordPress.Security.NonceVerification.Missing
			if ( empty( $_POST[ $nonce_field ] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST[ $nonce_field ] ) ), 'wpxmcp_fields_' . $group['group_key'] ) ) {
				continue;
			}

			foreach ( $group['fields'] as $field ) {
				// phpcs:ignore WordPress.Security.NonceVerification.Missing
				$raw = isset( $_POST[ $field['key'] ] ) ? wp_unslash( $_POST[ $field['key'] ] ) : null;

				if ( null === $raw ) {
					// An unchecked checkbox group submits nothing at all.
					if ( 'checkbox' === $field['type'] ) {
						delete_post_meta( $post_id, $field['key'] );
					}
					continue;
				}

				// update_post_meta() unslashes; the value was already unslashed above.
				update_post_meta( $post_id, $field['key'], wp_slash( $this->sanitize_value( $field, $raw ) ) );
			}
		}
	}

	/**
	 * Type-aware sanitisation.
	 *
	 * @param array $field Field definition.
	 * @param mixed $raw   Submitted value.
	 * @return mixed
	 */
	private function sanitize_value( $field, $raw ) {
		switch ( $field['type'] ) {
			case 'wysiwyg':
				return wp_kses_post( (string) $raw );

			case 'textarea':
				return sanitize_textarea_field( (string) $raw );

			case 'email':
				return sanitize_email( (string) $raw );

			case 'url':
				return esc_url_raw( (string) $raw );

			case 'number':
				return '' === $raw ? '' : (float) $raw;

			case 'color':
				return sanitize_hex_color( (string) $raw ) ?? '';

			case 'image':
				return (int) $raw;

			case 'gallery':
				$ids = is_array( $raw ) ? $raw : explode( ',', (string) $raw );
				return array_values( array_filter( array_map( 'intval', $ids ) ) );

			case 'checkbox':
				return array_map( 'sanitize_text_field', (array) $raw );

			case 'repeater':
				$rows = array();
				foreach ( (array) $raw as $row ) {
					$clean = array();
					foreach ( (array) $field['sub_fields'] as $sub ) {
						if ( ! isset( $row[ $sub['key'] ] ) ) {
							continue;
						}
						$clean[ $sub['key'] ] = $this->sanitize_value( $sub, $row[ $sub['key'] ] );
					}
					if ( array_filter( $clean, static function ( $v ) {
						return '' !== $v && array() !== $v;
					} ) ) {
						$rows[] = $clean;
					}
				}
				return $rows;

			default:
				return sanitize_text_field( (string) $raw );
		}
	}

	/**
	 * Settings page for option-context groups.
	 */
	public function add_settings_page() {
		$has_options = false;
		foreach ( self::groups() as $group ) {
			if ( 'options' === $group['context'] ) {
				$has_options = true;
				break;
			}
		}
		if ( ! $has_options ) {
			return;
		}

		add_options_page(
			__( 'Site Fields', 'wpxmcp' ),
			__( 'Site Fields', 'wpxmcp' ),
			'manage_options',
			'wpxmcp-fields',
			array( $this, 'render_settings_page' )
		);
	}

	/**
	 * Register the settings group.
	 */
	public function register_settings() {
		// Fields are registered in register_meta(); nothing further is needed here.
	}

	/**
	 * Render the settings page.
	 */
	public function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( isset( $_POST['wpxmcp_settings_nonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['wpxmcp_settings_nonce'] ) ), 'wpxmcp_save_settings' ) ) {
			foreach ( self::groups() as $group ) {
				if ( 'options' !== $group['context'] ) {
					continue;
				}
				foreach ( $group['fields'] as $field ) {
					// phpcs:ignore WordPress.Security.NonceVerification.Missing
					$raw = isset( $_POST[ $field['key'] ] ) ? wp_unslash( $_POST[ $field['key'] ] ) : ( 'checkbox' === $field['type'] ? array() : null );
					if ( null === $raw || wpxmcp_is_protected_option( $field['key'] ) ) {
						continue;
					}
					update_option( $field['key'], $this->sanitize_value( $field, $raw ) );
				}
			}
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__( 'Settings saved.', 'wpxmcp' ) . '</p></div>';
		}

		echo '<div class="wrap"><h1>' . esc_html__( 'Site Fields', 'wpxmcp' ) . '</h1>';
		echo '<form method="post">';
		wp_nonce_field( 'wpxmcp_save_settings', 'wpxmcp_settings_nonce' );

		foreach ( self::groups() as $group ) {
			if ( 'options' !== $group['context'] ) {
				continue;
			}
			echo '<h2>' . esc_html( $group['title'] ) . '</h2>';
			if ( ! empty( $group['description'] ) ) {
				echo '<p class="description">' . esc_html( $group['description'] ) . '</p>';
			}
			foreach ( $group['fields'] as $field ) {
				$this->render_field( $field, get_option( $field['key'], $field['default'] ) );
			}
		}

		submit_button();
		echo '</form></div>';
	}
}
